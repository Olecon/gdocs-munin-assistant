'use strict';
// The prose helpers of src/prose-tools.js and the logic of /polish (src/polish.js): the section note on the first write
// into a section (once per section per turn, not used up by a refused write, only in the model's turns; a subsection's
// type from the classic section above it); trim_to_words (a quiet request, the word count decides, one retry with the
// real count, an error after two misses, its offers); the criteria line of a vague improve request (doc-conventions.js
// criteriaLine; whole classic headings only); the connectivity note after a multi-paragraph write, its budget and its
// request (the end of the paragraph before, the start of the one after, whole sentences, against a stand-in judge that
// blames a paragraph cut mid-sentence); phrase_usage against a fake OpenAlex with the References grant; /polish's
// scope, its deterministic findings with Apply where mechanical and the model's fixes with the drift filter. The Apply
// click of /polish (the shared write path of the /check card) is in test/dom/polish.test.js.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, installIdentity } = require('./lib/sandbox');
const { sseResponse, textRound } = require('./lib/streams');
const { docSpec, docsBench } = require('./lib/fake-docs');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, bench;

const CYCLE = ['membrane', 'order', 'rose', 'in', 'the', 'treated', 'cells', 'and', 'fell', 'after', 'washing', 'them'];
const words = (n, from = 0) => Array.from({ length: n }, (_, i) => CYCLE[(i + from) % CYCLE.length]).join(' ') + '.';
const I1 = 'Membrane order controls how proteins sort between domains in living cells.';
const M1 = 'We grew the cells in a standard medium for two days at 37 °C.';
const M2 = 'We then stained them with Laurdan at 5 µM for thirty minutes in the dark.';
const LONG = words(60);
const R1 = 'Order rose by 12% in treated cells compared with the controls (Fig. 2).';
const ITEMS = [
  { p: 'Membrane order', style: 'TITLE' },
  { p: 'Introduction', style: 'HEADING_1' }, { p: I1 },
  { p: 'Methods', style: 'HEADING_1' }, { p: M1 }, { p: M2 }, { p: LONG },
  { p: 'Results', style: 'HEADING_1' }, { p: R1 },
];
// Lines: 1 title, 2 Introduction, 3 I1, 4 Methods, 5 M1, 6 M2, 7 LONG, 8 Results, 9 R1.

before(async () => {
  env = await load();
  ({ T, state } = env);
  const ident = installIdentity(env);
  bench = docsBench(env, ident, ref);
  installDocTab(env);
  env.chrome.tabs.sendMessage = async (id, msg) => (msg.type === 'GET_SELECTION' ? { ok: true, text: '' } : { ok: true, title: 'My Doc' });
  await T.refreshContext({ force: true });
  state.googleConnected = true; state.applyMode = 'auto';
  for (const id of ['munin', 'openai', 'anthropic']) state.settings.providers[id].apiKey = 'k-' + id;
  env.chrome.permissions = { contains: async () => true, request: async () => true };
});

// A fresh document on prov; the provider answers its requests with answers[i] (Anthropic text rounds; Munin chat SSE;
// a function gets the request body). Returns the provider request bodies. extra(url, init): other hosts (OpenAlex).
async function setup(prov = 'anthropic', answers = [], extra = null, items = ITEMS) {
  state.settings.provider = prov;
  await bench.fresh(docSpec({ items }));
  as.chatCtx = { docId: 'DOC123', chatId: state.chatId, messages: [] };
  const bodies = [];
  env.ctx.fetch = async (url, init) => {
    const d = await fake.fetch(url, init);
    if (d) return d;
    if (extra && String(url).includes('openalex')) return extra(url, init);
    bodies.push(JSON.parse(init.body));
    const a = typeof answers[bodies.length - 1] === 'function' ? answers[bodies.length - 1](bodies[bodies.length - 1]) : answers[bodies.length - 1];
    if (a == null) throw new Error('no answer scripted for request ' + bodies.length);
    return prov === 'munin' ? muninSse(a) : sseResponse(textRound(a));
  };
  return bodies;
}
const muninSse = (t) => sseResponse(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
const exec = (name, args) => bench.exec(name, args);
const userText = (b) => (b.messages ? (typeof b.messages[b.messages.length - 1].content === 'string' ? b.messages[b.messages.length - 1].content : JSON.stringify(b.messages)) : '');
const systemText = (b) => (typeof b.system === 'string' ? b.system : JSON.stringify(b.system || b.messages[0].content));

// ---- The section note ----------------------------------------------------------------------------------------------
test('the section note: the first write of a turn into a section gets it once; a refused write does not use it up; only in the model\'s turns', async () => {
  await setup('anthropic', ['OK', 'OK']); // the connectivity check of the inserts
  as.mainTurn = true;
  const note = 'Note: Section «Methods»: continue its register; it so far says: "We grew the cells in a standard medium for two days at 37 °C." Methods use the past tense and enough detail to repeat the work; no results.';
  const r1 = await exec('insert_after_line', { line: 5, text: 'The cells were then washed twice in cold buffer and kept on ice until imaging.' });
  assert.ok(r1._ok && r1.content.endsWith('\n' + note), r1.content);
  const r2 = await exec('insert_after_line', { line: 6, text: 'Each dish was imaged within one hour of staining to keep the dye from fading.' });
  assert.ok(r2._ok && !r2.content.includes('Section «'), r2.content); // the same section: once per turn
  // a refused write into Results (it drops 12%) leaves the note for the next write there
  const refused = await exec('replace_text', { old_text: R1, new_text: 'Order rose in treated cells compared with the controls (Fig. 2).' });
  assert.ok(refused.content.startsWith('Refused by a check'), refused.content);
  const r3 = await exec('replace_text', { old_text: 'compared with the controls (Fig. 2).', new_text: 'compared with the controls (Fig. 2), and the rise held in each of the three repeat experiments we ran.' });
  assert.ok(r3._ok && r3.content.includes('\nNote: Section «Results»: continue its register; it so far says: "Order rose by 12%'), r3.content);
  // a new turn notes again; a snapshot that is no model turn (a unit call, the card writes) gets none
  as.sectionNoted = null;
  const r4 = await exec('replace_text', { old_text: 'for two days at 37 °C.', new_text: 'for two days at 37 °C, changing the medium once after the first day to keep it fresh.' });
  assert.ok(r4.content.includes('Note: Section «Methods»'), r4.content);
  await setup();
  const r5 = await exec('insert_after_line', { line: 5, text: 'The cells were then washed twice in cold buffer and kept on ice until imaging.' });
  assert.ok(r5._ok && !r5.content.includes('Section «'), r5.content);
});

test('the section note: not for a write without a sentence of new prose (a changed number or word, a caption, formatting)', async () => {
  await setup('anthropic', ['OK', 'OK']); // the connectivity check of the inserts
  as.mainTurn = true;
  const quiet = async (name, args) => { const r = await exec(name, args); assert.ok(r._ok && !r.content.includes('Section «'), `${name}: ${r.content}`); };
  await quiet('replace_text', { old_text: 'thirty minutes', new_text: '30 minutes' }); // a few characters
  // the whole sentence sent again with one word changed: the words it keeps are no new prose
  await quiet('replace_text', { old_text: M1, new_text: 'We grew the cells in a standard medium for three days at 37 °C.' });
  await quiet('insert_after_line', { line: 6, text: 'Fig. S1 Laurdan spectra of the treated and the untreated cells at 37 °C' }); // no sentence end
  await quiet('edit_document', { operations: [
    { op: 'format_lines', start: 3, end: 3, align: 'justify' },
    { op: 'replace', old_text: 'in the dark', new_text: 'in darkness' }] });
  // the first part with prose decides the section: a changed number in Methods, then a sentence in Results (line 10 now)
  const r = await exec('edit_document', { operations: [
    { op: 'replace', old_text: 'Laurdan at 5', new_text: 'Laurdan at 5.0' },
    { op: 'insert', line: 10, text: 'Order also rose in cells that were treated for a single hour before the wash.', style: null }] });
  assert.ok(r._ok && r.content.includes('Note: Section «Results»'), r.content);
});

// Topical subsections: an Introduction subsection whose heading names "limitations" and one that names "methods", a
// classic Methods section and a topical top-level section.
const E1 = 'Earlier probes reported order only in fixed cells and only at the plasma membrane.';
const E2 = 'They also bleached within seconds, which ruled out any imaging over time.';
const NEST_ITEMS = [
  { p: 'Membrane order', style: 'TITLE' },
  { p: 'Introduction', style: 'HEADING_1' }, { p: I1 },
  { p: 'Earlier methods', style: 'HEADING_2' }, { p: E1 }, { p: E2 },
  { p: 'Probes and their limitations', style: 'HEADING_2' }, { p: 'Most probes report order only in fixed cells and bleach within seconds of light.' },
  { p: 'Methods', style: 'HEADING_1' }, { p: M1 },
  { p: 'Notes on the probes', style: 'HEADING_1' }, { p: 'Laurdan and its relatives shift their emission with the water content of the bilayer.' },
];
// Lines: 1 title, 2 Introduction, 3 I1, 4 Earlier methods, 5 E1, 6 E2, 7 Probes and their limitations, 8 P, 9 Methods,
// 10 M1, 11 Notes on the probes, 12 N.

test('the section note: a subsection takes the type of the classic section above it, a topical section gets no type clause', async () => {
  await setup('anthropic', ['OK', 'OK'], null, NEST_ITEMS); // the connectivity check of the inserts
  as.mainTurn = true;
  const r1 = await exec('insert_after_line', { line: 8, text: 'Newer dyes last longer under light but still need the cells to be fixed first.' });
  assert.ok(r1._ok && r1.content.endsWith('\nNote: Section «Probes and their limitations»: continue its register; it so far says: "Most probes report order only in fixed cells and bleach within seconds of light." An introduction moves from what is known to the gap to the aim.'), r1.content);
  assert.ok(!r1.content.includes('Limitations name'), r1.content);
  const r2 = await exec('insert_after_line', { line: 13, text: 'Their relatives differ mainly in how deep they sit in the bilayer and how bright they are.' });
  assert.ok(r2._ok && r2.content.endsWith('\nNote: Section «Notes on the probes»: continue its register; it so far says: "Laurdan and its relatives shift their emission with the water content of the bilayer."'), r2.content);
});

test('the criteria line: only a heading that is the classic section itself, not a subsection or a topical heading with the word', async () => {
  await setup('anthropic', [], null, NEST_ITEMS);
  // "Earlier methods" is an Introduction subsection: the methods request finds the Methods section
  assert.ok(T.criteriaLine(as, 'Improve the methods').startsWith('Criteria for improving «Methods» (methods):'), T.criteriaLine(as, 'Improve the methods'));
  assert.strictEqual(T.criteriaLine(as, 'Improve the limitations'), ''); // no criteria for limitations, and no such section
  // a selection in a subsection is a part of the Introduction: not judged by section criteria
  as.selection = `${E1}\n${E2}`;
  assert.strictEqual(T.criteriaLine(as, 'Make this better'), '');
  as.selection = '';
});

// ---- trim_to_words --------------------------------------------------------------------------------------------------
const trimArgs = (extra = {}) => ({ line_start: 7, line_end: 7, words: 30, keep: null, ...extra });
test('trim_to_words: an answer within 10% of the target is written (verified, undoable) and the real count reported', async () => {
  const bodies = await setup('anthropic', [words(31)]);
  const r = await exec('trim_to_words', trimArgs());
  assert.ok(r._ok, r.content);
  assert.ok(r.content.startsWith('Done: trimmed line 7 from 60 to 31 words (target 30); the document has 9 lines.'), r.content);
  assert.strictEqual(fake.text('t.0').split('\n')[6], words(31));
  deq([r._detail, r._edit.kind], ['1 request, 53 tokens', 'replace']);
  // one quiet request: the head, the document writing rules, the target and the passage
  assert.strictEqual(bodies.length, 1);
  assert.ok(!bodies[0].tools && bodies[0].messages.length === 1);
  assert.ok(systemText(bodies[0]).startsWith(T.TRIM_HEAD.slice(0, 60)) && systemText(bodies[0]).includes('W1. Write like this document'));
  const u = userText(bodies[0]);
  assert.ok(u.includes('Section «Methods»: continue its register;') && u.includes('\nTarget: about 30 words (the passage has 60).\nPassage:\n' + LONG), u);
  // undo restores the passage
  const res = await T.undoEdit(r._edit);
  assert.ok(res.model);
  assert.strictEqual(fake.text('t.0').split('\n')[6], LONG);
});

test('trim_to_words: one retry with the real count; two misses write nothing and name both counts', async () => {
  let bodies = await setup('anthropic', [words(40), words(29)]);
  let r = await exec('trim_to_words', trimArgs());
  assert.ok(r._ok && r.content.startsWith('Done: trimmed line 7 from 60 to 29 words (target 30)'), r.content);
  assert.strictEqual(r._detail, '2 requests, 106 tokens');
  assert.ok(userText(bodies[1]).endsWith('\n\nYou wrote 40 words; the target is 30. Cut the passage again to about 30 words.'), userText(bodies[1]));
  bodies = await setup('anthropic', [words(40), words(38)]);
  r = await exec('trim_to_words', trimArgs());
  deq([r._ok, r.content], [false, 'Error: could not reach 30 words (got 40 then 38); the span was not changed. Shorten it with replace_text instead.']);
  assert.strictEqual(fake.text('t.0').split('\n')[6], LONG);
  assert.strictEqual(fake.log.filter((x) => x.method === 'POST').length, 0);
  // keep: the text must stay; an answer without it is a miss
  bodies = await setup('anthropic', [Array(30).fill('alpha').join(' ') + '.', words(30)]);
  r = await exec('trim_to_words', trimArgs({ keep: 'membrane order rose' }));
  assert.ok(r._ok, r.content);
  assert.ok(userText(bodies[0]).includes('Keep word for word: «membrane order rose»'));
  assert.ok(userText(bodies[1]).includes('You also dropped the text to keep.'));
});

test('trim_to_words: refusals before any request (a heading in the span, nothing to trim, bad numbers, keep not in the span)', async () => {
  const bodies = await setup('anthropic', []);
  let r = await exec('trim_to_words', trimArgs({ line_start: 6, line_end: 8 }));
  assert.strictEqual(r.content, 'Error: line 8 is a heading; trim_to_words rewrites body paragraphs only. Give a span without it.');
  r = await exec('trim_to_words', trimArgs({ line_start: 5, line_end: 6, words: 40 }));
  deq([r._ok, r.content], [true, 'Lines 5–6 have 29 words, within 10% of 40 or under it; nothing changed.']);
  r = await exec('trim_to_words', trimArgs({ line_end: 99 }));
  assert.ok(r.content.startsWith('Error: line_start and line_end must be line numbers'), r.content);
  r = await exec('trim_to_words', trimArgs({ keep: 'not in the text' }));
  assert.ok(r.content.startsWith('Error: keep must be text from line 7'), r.content);
  assert.strictEqual(bodies.length, 0);
});

test('trim_to_words and phrase_usage: offered on demand on Munin and custom servers, always on providers with a prompt cache', async () => {
  const names = (mode, s) => T.toolsFor(mode, s).map((t) => t.function.name);
  const snapOn = (prov, text) => {
    state.settings.provider = prov;
    const s = T.takeSnapshot(); T.snapshotDocument(s);
    s.chatCtx = { docId: state.docId, chatId: state.chatId, messages: [{ role: 'user', content: text }] };
    return s;
  };
  await setup();
  const plain = 'Rewrite the Methods section so that it reads better and keeps every value as written.';
  for (const prov of ['anthropic', 'openai']) {
    assert.ok(names('edit', snapOn(prov, plain)).includes('trim_to_words'), prov);
    assert.ok(names('edit', snapOn(prov, plain)).includes('phrase_usage') && names('manual', snapOn(prov, plain)).includes('phrase_usage'), prov);
    assert.ok(!names('manual', snapOn(prov, plain)).includes('trim_to_words'), prov); // a write tool: Auto only
  }
  const mu = (t) => names('edit', snapOn('munin', t));
  assert.ok(!mu(plain).includes('trim_to_words') && !mu(plain).includes('phrase_usage'));
  for (const t of ['Trim the Methods to 150 words.', 'Сократи введение до 200 слов.', 'Ужми этот абзац.', 'Cut it down to 100 words.']) assert.ok(mu(t).includes('trim_to_words'), t);
  for (const t of ['Is "in good agreement with" idiomatic?', 'Так говорят по-английски?', 'Check the wording of the first sentence.']) assert.ok(mu(t).includes('phrase_usage'), t);
  // a call made unoffered still runs
  const s = snapOn('munin', plain);
  for (const n of ['trim_to_words', 'phrase_usage']) assert.ok(T.extraRuns(T.extraTool(n), 'edit', s), n);
  state.settings.provider = 'anthropic';
});

// ---- The criteria line ------------------------------------------------------------------------------------------------
test('the criteria line: a vague improve request on a classic section, by its name or the selection; none for a concrete one', async () => {
  await setup();
  const intro = 'Criteria for improving «Introduction» (introduction): the first paragraph names the problem for a non-specialist; the gap is stated before the contribution; the contributions are listed; related work is set against the gap. Use those that fit the text in question; name the ones you used in one short line.';
  assert.strictEqual(T.criteriaLine(as, 'Improve the introduction'), intro);
  assert.strictEqual(T.criteriaLine(as, 'улучши введение'), intro);
  assert.ok(T.criteriaLine(as, 'make the methods better').startsWith('Criteria for improving «Methods» (methods): enough detail to repeat the work; every parameter with its value and unit;'));
  assert.ok(T.criteriaLine(as, 'Polish the results').startsWith('Criteria for improving «Results» (results): each finding with its number;'));
  // concrete or not about a section: no line
  for (const t of ['Shorten the introduction to 200 words', 'Improve the introduction: add a sentence about rafts', 'Fix the typos in the introduction',
    'Improve it', 'Improve the discussion', 'What does the introduction say?']) assert.strictEqual(T.criteriaLine(as, t), '', t);
  // the selection names the section: two of its paragraphs, or the only paragraph of a section
  as.selection = `${M1}\n${M2}`;
  assert.ok(T.criteriaLine(as, 'Make this better').startsWith('Criteria for improving «Methods» (methods):'));
  as.selection = I1;
  assert.strictEqual(T.criteriaLine(as, 'Make this better'), intro);
  // one selected paragraph of a section with several: not judged by the section's criteria; a section the message names is
  as.selection = M2;
  assert.strictEqual(T.criteriaLine(as, 'Make this better'), '');
  assert.ok(T.criteriaLine(as, 'Improve the methods').startsWith('Criteria for improving «Methods» (methods):'));
  as.selection = '';
  // each kind has 3–5 criteria, each short
  for (const [k, list] of Object.entries(T.SECTION_CRITERIA)) assert.ok(list.length >= 3 && list.length <= 5 && list.every((c) => c.length < 70), k);
});

// ---- The connectivity note --------------------------------------------------------------------------------------------
test('connectivity: a non-OK answer after a two-paragraph insert becomes a note; OK adds none; at most two requests per turn', async () => {
  const gap = 'The new paragraph starts from scratch; its first sentence does not refer to the previous paragraph\'s claim about staining.';
  const bodies = await setup('anthropic', [gap, 'OK.']);
  as.mainTurn = true;
  as.sectionNoted = new Set(['1\u0000methods']); // the section note is tested above
  const two = `${words(12)}\n${words(14, 3)}`;
  let r = await exec('insert_after_line', { line: 6, text: two });
  assert.ok(r._ok && r.content.endsWith(`\nNote: Connectivity: ${gap}`), r.content);
  assert.strictEqual(bodies.length, 1);
  assert.ok(systemText(bodies[0]).startsWith(T.CONNECT_HEAD));
  const u = userText(bodies[0]);
  assert.ok(u.startsWith(`Paragraph before:\n${M2}\n\nNew text, first paragraph:\n${words(12)}\n\nNew text, last paragraph:\n${words(14, 3)}\n\nParagraph after:\n${LONG}`), u);
  r = await exec('insert_after_line', { line: 3, text: two });
  assert.ok(r._ok && !r.content.includes('Connectivity'), r.content);
  r = await exec('insert_after_line', { line: 3, text: two }); // the budget is spent: no third request
  assert.strictEqual(bodies.length, 2);
  // one-paragraph replace: no request; not outside a model turn
  as.connectAsked = 0;
  await exec('replace_text', { old_text: 'thirty minutes', new_text: '30 minutes' });
  as.mainTurn = false;
  await exec('insert_after_line', { line: 6, text: two });
  assert.strictEqual(bodies.length, 2);
});

// Long synthetic neighbours (over 400 characters each): the paragraph before ends on staining with Laurdan, the one
// after opens on the GP maps.
const BEFORE = ['Membrane order differs between cell types and between the domains of a single membrane.', 'Cholesterol raises it, and unsaturated lipids lower it, so diet and drugs both shift it within hours.',
  'To measure it in living cells we first grew them on glass for two days in a standard medium.', 'They were then washed twice in warm buffer to remove the serum, which would bind the dye.',
  'The last step stained the washed cells with Laurdan at 5 µM for thirty minutes in the dark.'];
const AFTER = ['The resulting GP maps showed brighter, more ordered patches at the cell edges than in the centre.', 'Treated cells kept these patches for the whole hour of imaging, whereas the controls lost them within twenty minutes.',
  'The patches did not depend on the focal plane, which rules out a simple optical artefact of the cell edge.', 'Their size matched earlier reports from fixed cells within the error of the measurement.'];
const JOIN_ITEMS = [
  { p: 'Membrane order', style: 'TITLE' },
  { p: 'Methods', style: 'HEADING_1' }, { p: BEFORE.join(' ') }, { p: AFTER.join(' ') },
];
// Lines: 1 title, 2 Methods, 3 BEFORE, 4 AFTER.
// A stand-in for the judge that acts as the real one did in the writing eval: a paragraph before that stops mid-sentence
// is "a gap"; otherwise the join is OK when the new text's first sentence takes up a word of the last sentence before it.
const sentencesOf = (t) => t.split(/(?<=[.!?])\s+/);
const longWords = (t) => new Set(t.toLowerCase().match(/\p{L}{6,}/gu) || []);
function judge(body) {
  const u = userText(body);
  const before = /Paragraph before:\n(.*)/.exec(u)[1];
  const first = /New text(?:, first paragraph)?:\n(.*)/.exec(u)[1];
  if (!/[.!?]$/.test(before)) return `The paragraph before ends mid-thought ("${before.slice(-12)}"), so the new text does not continue it.`;
  const last = longWords(sentencesOf(before).pop());
  return [...longWords(sentencesOf(first)[0])].some((w) => last.has(w)) ? 'OK' : 'The new text opens on cell counts, which the staining paragraph before it never mentions.';
}

test('connectivity: long neighbours are sent as the end of the paragraph before and the start of the one after, whole sentences', async () => {
  const bodies = await setup('anthropic', [judge, judge], null, JOIN_ITEMS);
  as.mainTurn = true;
  const joined = 'Laurdan fluorescence was then recorded at two emission wavelengths on a confocal microscope kept warm.\nThe two images of each cell gave one generalized polarization (GP) map, computed pixel by pixel.';
  let r = await exec('insert_after_line', { line: 3, text: joined });
  assert.ok(r._ok && !r.content.includes('Connectivity'), r.content); // connected text: no note
  const u = userText(bodies[0]);
  // the paragraph before ends where it ends; the one after starts where it starts; "[…]" marks the cuts
  assert.ok(u.startsWith(`Paragraph before:\n[…] ${BEFORE.slice(-4).join(' ')}\n\nNew text, first paragraph:\n`), u);
  assert.ok(!u.includes(BEFORE[0]), u);
  assert.ok(u.endsWith(`\n\nParagraph after:\n${AFTER.slice(0, 3).join(' ')} […]`), u);
  assert.ok(systemText(bodies[0]).startsWith(T.CONNECT_HEAD) && T.CONNECT_HEAD.includes('[…] marks text left out, which is not a gap'));
  // a real gap is still named (the paragraph before is now lines 3, the new text 4–5 again after the first insert's 4–5)
  r = await exec('insert_after_line', { line: 5, text: 'Cell counts rose from forty to sixty per field over the week of culture in every dish.\nThe counts were taken by hand from bright-field images of each dish at the same time of day.' });
  assert.ok(r._ok && r.content.endsWith('\nNote: Connectivity: The new text opens on cell counts, which the staining paragraph before it never mentions.'), r.content);
  assert.strictEqual(bodies.length, 2);
});

test('connectivity: one long new paragraph is sent by both ends; a long answer is cut at a sentence', async () => {
  const gap = 'The new paragraph restates the staining instead of moving on to the GP maps that follow it.';
  const more = 'It also repeats the dye concentration and the time, which the paragraph before already gives.';
  const bodies = await setup('anthropic', [`${gap} ${more} ${more} ${more}`], null, JOIN_ITEMS);
  as.mainTurn = true;
  const S = ['Laurdan fluorescence was then recorded at two emission wavelengths on a confocal microscope kept warm.',
    'Each field was imaged with the same laser power and gain, chosen on the brightest control dish of the day.',
    'Fields with fewer than five cells or with any sign of blebbing were left out before the analysis began.',
    'The background of each channel was taken from a cell-free corner of the same field and subtracted.',
    'The two images of each cell gave one generalized polarization (GP) map, computed pixel by pixel.'];
  const para = S.join(' ').repeat(2).replace(/\.(?=\S)/g, '. ');
  const r = await exec('insert_after_line', { line: 3, text: para });
  assert.ok(r._ok && r.content.endsWith(`\nNote: Connectivity: ${gap} ${more} […]`), r.content); // whole sentences up to 220 characters
  const u = userText(bodies[0]);
  const m = /\n\nNew text:\n(.*)\n\nParagraph after:/.exec(u);
  assert.ok(m && m[1].startsWith(`${S[0]} ${S[1]} `) && m[1].includes(' […] ') && m[1].endsWith(S[4]) && m[1].length <= 800, u);
});

test('connectivity on Munin: a one-paragraph insert is not checked, two paragraphs are (summary sampling, no tools)', async () => {
  const bodies = await setup('munin', ['OK']);
  as.mainTurn = true;
  await exec('insert_after_line', { line: 6, text: words(12) });
  assert.strictEqual(bodies.length, 0);
  await exec('insert_after_line', { line: 6, text: `${words(12)}\n${words(14, 3)}` });
  assert.strictEqual(bodies.length, 1);
  assert.ok(!bodies[0].tools && bodies[0].persona === 'raw');
});

// ---- phrase_usage ---------------------------------------------------------------------------------------------------------
test('phrase_usage: the exact-phrase OpenAlex filter, the count and two examples; no works; at most three calls; the grant', async () => {
  const urls = [];
  let answer = { meta: { count: 246022 }, results: [{ display_name: 'Coleman-Weinberg potential in good agreement with WMAP', publication_year: 2006 },
    { display_name: 'Quantum contextuality is in good agreement with the delayed-choice method', publication_year: 2023 }, { display_name: 'Third', publication_year: 2020 }] };
  await setup('anthropic', [], async (url) => { urls.push(String(url)); return { ok: true, status: 200, json: async () => answer }; });
  state.settings.references = true;
  let r = await exec('phrase_usage', { phrase: 'in good agreement with' });
  assert.strictEqual(r.content, 'About 246,022 works use “in good agreement with” in the title or abstract; e.g. "Coleman-Weinberg potential in good agreement with WMAP" (2006), "Quantum contextuality is in good agreement with the delayed-choice method" (2023).');
  assert.ok(r._reading);
  assert.strictEqual(urls[0], 'https://api.openalex.org/works?filter=title_and_abstract.search:%22in%20good%20agreement%20with%22&per-page=3&select=id,display_name,publication_year');
  answer = { meta: { count: 0 }, results: [] };
  r = await exec('phrase_usage', { phrase: 'in a good agreement to' });
  assert.strictEqual(r.content, 'No works found with that exact phrase.');
  r = await exec('phrase_usage', { phrase: 'agreement' });
  assert.strictEqual(r.content, 'Error: phrase must have 3 to 8 words (it has 1).');
  r = await exec('phrase_usage', { phrase: 'in close agreement with' });
  assert.ok(r.content.startsWith('Error: at most 3 phrase_usage calls per message'), r.content);
  assert.strictEqual(urls.length, 2);
  // without the grant, a quiet turn has nobody to ask: the denial text
  await setup('anthropic', [], async () => { throw new Error('no lookup expected'); });
  state.settings.references = false;
  as.quiet = true;
  r = await exec('phrase_usage', { phrase: 'in good agreement with' });
  assert.strictEqual(r.content, 'Reference lookups were not allowed. Call find_reference or cite again only if the user asks for a lookup; a citation the user gives or wants as plain text needs none: type it.');
});

// ---- /polish: scope and findings ------------------------------------------------------------------------------------------
const POLISH_ITEMS = [
  { p: 'Order paper', style: 'TITLE' },
  { p: 'Methods', style: 'HEADING_1' },
  { p: 'In order to stain the cells, we used Laurdan at 5 µM for thirty minutes.' },
  { p: 'The results may potentially suggest that the order rose in the treated cells.' },
  { p: 'Results', style: 'HEADING_1' },
  { p: 'Membrane order rose by 12% in the treated cells, which highlights the role of cholesterol.' },
];
async function polishDoc() {
  state.settings.provider = 'anthropic';
  await bench.fresh(docSpec({ items: POLISH_ITEMS }));
  const doc = T.ckDocument({ model: as.model });
  return doc;
}
test('/polish: the scope (the selection, a named section, the whole short document) and the error for a long one', async () => {
  const doc = await polishDoc();
  deq(T.polishScope(doc, as, ''), { from: 1, to: 6, label: 'the whole document' });
  deq(T.polishScope(doc, as, 'results'), { from: 5, to: 6, label: '«Results»' });
  assert.strictEqual(T.polishScope(doc, as, 'Discussion').error, 'No heading reads «Discussion». Name a heading as the document shows it, or select the text, then run /polish again.');
  as.selection = POLISH_ITEMS[3].p;
  deq(T.polishScope(doc, as, ''), { from: 4, to: 4, label: 'the selection (line 4)' });
  as.selection = '';
  const long = { lines: [{ line: 1, text: words(2100), heading: 0 }] };
  assert.strictEqual(T.polishScope(long, as, '').error, 'The document has 2,100 words; /polish works on at most 2,000 at once. Select a section, or name it (/polish Introduction), and run /polish again.');
});

test('/polish: deterministic findings in paragraph order, Apply on the mechanical swaps only', async () => {
  const doc = await polishDoc();
  const paras = doc.lines.filter((l) => [3, 4, 6].includes(l.line));
  const list = T.polishMechanical(doc, paras, { docText: as.docText });
  const rows = list.map((f) => [f.line, f.rule, f.text, !!f.fix]);
  // the wordy phrase (mechanical: Apply; the same span's wordy tell is not listed again), the stacked hedge (no Apply), the
  // stock word with a literal alternative (Apply)
  assert.ok(rows.some((r) => r[0] === 3 && r[1] === 'wordy-phrase' && r[2] === '«In order to» → «to».' && r[3]), JSON.stringify(rows));
  assert.ok(rows.some((r) => r[0] === 4 && r[1] === 'claim-stacked' && !r[3]), JSON.stringify(rows));
  assert.ok(rows.some((r) => r[0] === 6 && r[1] === 'tell-stock' && /«highlights the»: "shows the"\./.test(r[2]) && r[3]), JSON.stringify(rows));
  deq(list.map((f) => f.line), list.map((f) => f.line).slice().sort((a, b) => a - b));
  const wordy = list.find((f) => f.rule === 'wordy-phrase');
  deq(wordy.fix.edits, [{ line: 3, at: 0, len: 11, to: 'To', from: 'In order to' }]);
  // the DOC.md ignore list silences a rule
  assert.ok(!T.polishMechanical(doc, paras, { docText: as.docText, rules: new Set(['tell']) }).some((f) => f.rule.startsWith('tell-')));
});

test('/polish: the model\'s fixes become findings with Apply; a fix that drifts is dropped and counted; a bad quote is left out', async () => {
  const doc = await polishDoc();
  const l = doc.lines[2]; // 'In order to stain the cells, we used Laurdan at 5 µM for thirty minutes.'
  const good = 'To stain the cells, we used Laurdan at 5 µM for thirty minutes.';
  const raw = JSON.stringify([
    { quote: l.text, replacement: good, why: 'shorter' },
    { quote: l.text, replacement: 'To stain the cells, we may have used Laurdan at 5 µM for thirty minutes.', why: 'hedged' }, // modality: dropped
    { quote: l.text, replacement: 'To stain the cells, we used Laurdan at 5 µM for 30 minutes.', why: 'numeral' }, // a new number: dropped
    { quote: 'Not in the paragraph.', replacement: 'x', why: '' },
  ]);
  const r = T.polishModelFixes('<think>hm</think>```json\n' + raw + '\n```', l);
  deq([r.fixes.length, r.dropped, r.invalid], [1, 2, 1]);
  const f = r.fixes[0];
  assert.strictEqual(f.text, `«${l.text}» → «${good}» (shorter)`);
  deq(f.fix.edits, [{ line: 3, at: 0, len: l.text.length, to: good, from: l.text }]);
  // the fix runs through checkFixOps like a /check fix: one replace of the line
  const ops = T.checkFixOps(as.model, f.fix, new Map(doc.lines.map((x) => [x.line, x.text])));
  deq(ops.ops, [{ op: 'replace', old_text: l.text, new_text: good, line: 3 }]);
  // an answer that is no JSON: nothing
  deq(T.polishModelFixes('No changes needed.', l).fixes, []);
});
