'use strict';
// The paper card (src/paper-card.js): parsing the extraction (Munin-style sloppy JSON, strings for list items,
// aliases), the fields' text form, the <paper_card> line (size, staleness note), its storage key, the line in the
// turn context of ordinary turns (not in the static head, not in /review), staleness by changed lines, and the
// build: one quiet request on the document alone that leaves the chat untouched and stores nothing before Save.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load } = require('./lib/sandbox');
const { docBench, recordFetch, useProvider, send, muText } = require('./lib/context');

let env, T, state, doc;
const DOC = '# Fatigue trial\n\nDoes drug X reduce fatigue in adults with long COVID?\n\n## Results\n\nFatigue scores fell by 12% versus placebo (p = 0.03).';
const SLOPPY = 'Sure, here is the card:\n```json\n{"question": "Does drug X reduce fatigue in adults with long COVID?", "population": "adults with long COVID", "design": "randomized placebo-controlled trial",' +
  ' "comparator": "placebo", "outcomes": ["fatigue score", "adverse events"], "claims": ["Drug X reduced fatigue (line 7)", {"text": "It was well tolerated", "line": "L9"}],' +
  ' "numbers": ["12%: drop in fatigue score (line 7)", {"value": "0.03", "meaning": "p value", "line": 7},], }\n```\nLet me know!';
const KEY = 'muninPaperCard:DOC123';

before(async () => {
  env = await load();
  ({ T, state } = env);
  ({ doc } = docBench(env));
  doc.text = DOC;
  await T.refreshContext({ force: true });
});

test('parsePaperCard: the Munin-style sloppy answer; strings for list items; nothing usable: the error', () => {
  const r = T.parsePaperCard(SLOPPY);
  assert.strictEqual(r.ok, true);
  deq(r.card, {
    question: 'Does drug X reduce fatigue in adults with long COVID?', population_or_system: 'adults with long COVID',
    design: 'randomized placebo-controlled trial', comparator: 'placebo', outcomes: 'fatigue score; adverse events',
    main_claims: [{ text: 'Drug X reduced fatigue', line: 7 }, { text: 'It was well tolerated', line: 9 }],
    headline_numbers: [{ value: '12%', meaning: 'drop in fatigue score', line: 7 }, { value: '0.03', meaning: 'p value', line: 7 }],
  });
  const bad = T.parsePaperCard('I could not find a research question.');
  deq([bad.ok, bad.error], [false, 'The card did not come back as JSON. Try Rebuild.']);
  assert.strictEqual(T.parsePaperCard('{"question":"","main_claims":[]}').ok, false);
  // capped: at most 4 claims and 6 numbers
  const many = T.parsePaperCard(JSON.stringify({ question: 'Q', main_claims: Array.from({ length: 9 }, (_, i) => `c${i}`), headline_numbers: Array.from({ length: 9 }, (_, i) => `${i}`) }));
  deq([many.card.main_claims.length, many.card.headline_numbers.length], [4, 6]);
});

test('the fields round-trip: claims and numbers one per line with "(line N)"', () => {
  const card = T.parsePaperCard(SLOPPY).card;
  const values = {};
  for (const [f] of T.PAPER_CARD_FIELDS) values[f] = T.pcFieldText(card, f);
  assert.strictEqual(values.main_claims, 'Drug X reduced fatigue (line 7)\nIt was well tolerated (line 9)');
  assert.strictEqual(values.headline_numbers, '12%: drop in fatigue score (line 7)\n0.03: p value (line 7)');
  deq(T.cardFromFields(values), card);
});

test('the <paper_card> line: compact, about 150 tokens at most, with a note when stale; empty card: nothing', () => {
  const card = T.parsePaperCard(SLOPPY).card;
  const block = T.paperCardBlock(card);
  assert.strictEqual(block, '<paper_card>Question: Does drug X reduce fatigue in adults with long COVID? | Population or system: adults with long COVID | ' +
    'Design: randomized placebo-controlled trial | Comparator: placebo | Outcomes: fatigue score; adverse events | Main claims: Drug X reduced fatigue (L7); ' +
    'It was well tolerated (L9) | Headline numbers: 12% drop in fatigue score (L7); 0.03 p value (L7)</paper_card>');
  assert.ok(T.paperCardBlock(card, true).startsWith('<paper_card note="built before large changes; may be out of date">'));
  const long = 'word '.repeat(80);
  const big = T.cardFromFields({ question: long, population_or_system: long, design: long, comparator: long, outcomes: long, main_claims: `${long}\n${long}\n${long}\n${long}`, headline_numbers: `1: ${long}\n2: ${long}\n3: ${long}` });
  const capped = T.paperCardBlock(big);
  assert.ok(capped.length <= 640 + '<paper_card></paper_card>'.length, `${capped.length} characters`);
  assert.strictEqual(T.paperCardBlock(T.cardFromFields({})), '');
});

test('staleness: small edits keep the card current; many changed lines make it stale', () => {
  const text = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of the paper.`).join('\n');
  const facts = T.paperCardFacts(text);
  assert.strictEqual(T.paperCardStale(facts, text), false);
  const small = text.replace('Line 3 of', 'Line three of').replace('Line 9 of', 'Line nine of');
  assert.strictEqual(T.paperCardStale(facts, small), false);
  const large = text.split('\n').map((l, i) => (i < 10 ? l.toUpperCase() : l)).join('\n');
  assert.strictEqual(T.paperCardStale(facts, large), true);
  assert.strictEqual(T.paperCardStale(facts, text + '\n' + Array.from({ length: 12 }, (_, i) => `New ${i}.`).join('\n')), true);
  assert.strictEqual(T.paperCardStale(null, text), false);
});

test('storage: muninPaperCard:<docId>; an empty card removes the key; the numbers for other checks', async () => {
  const card = T.parsePaperCard(SLOPPY).card;
  await T.writePaperCard('DOC123', { card, facts: T.paperCardFacts(DOC), builtAt: 1, savedAt: 2 });
  deq(env.storage[KEY].card, card);
  deq(env.storage[KEY].facts.chars, DOC.length);
  deq(T.paperCardNumbers('DOC123'), ['12%', '0.03']);
  deq((await T.readPaperCard('DOC123')).card, card);
  await T.writePaperCard('DOC123', { card: T.cardFromFields({}) });
  assert.ok(!(KEY in env.storage));
  deq(T.paperCardNumbers('DOC123'), []);
});

test('the saved card goes into the turn context of ordinary turns, never into the static head or /review', async () => {
  useProvider(env, 'munin');
  await T.createChat();
  await T.writePaperCard('DOC123', { card: T.parsePaperCard(SLOPPY).card, facts: T.paperCardFacts(DOC), builtAt: 1, savedAt: 2 });
  let bodies = recordFetch(env, [muText('ok')]);
  await send(env, 'tighten the abstract');
  const [system, user] = bodies[0].messages.map((m) => m.content);
  assert.ok(!system.includes('paper_card'));
  assert.ok(user.includes('<paper_card>Question: Does drug X') && user.indexOf('<paper_card>') < user.indexOf('Current selection'));
  // stale after large changes: the line says so
  doc.text = DOC + '\n' + Array.from({ length: 10 }, (_, i) => `Added paragraph ${i}.`).join('\n');
  bodies = recordFetch(env, [muText('ok')]);
  await send(env, 'next');
  assert.ok(bodies[0].messages[bodies[0].messages.length - 1].content.includes('<paper_card note="built before large changes'));
  // /review stays independent of the card
  bodies = recordFetch(env, [muText('{"findings":[]}')]);
  await send(env, '/review now');
  assert.ok(!JSON.stringify(bodies[0]).includes('paper_card'));
  doc.text = DOC;
  await T.writePaperCard('DOC123', null);
});

test('Build: one quiet request on the document alone (no tools, no history); a draft until Save; the chat is untouched', async () => {
  useProvider(env, 'munin');
  doc.text = DOC;
  await T.createChat();
  recordFetch(env, [muText('ok')]);
  await send(env, 'an earlier question');
  const chat = JSON.stringify(state.messages);
  const stored = JSON.stringify(env.storage);
  const bodies = recordFetch(env, [muText(SLOPPY)]);
  const card = await T.buildPaperCard();
  assert.strictEqual(bodies.length, 1);
  const b = bodies[0];
  deq([b.persona, b.tools, b.messages.map((m) => m.role)], ['raw', undefined, ['system', 'user']]);
  assert.ok(b.messages[0].content.startsWith(T.DOC_PASS_HEADS.card) && !b.messages[0].content.includes('W1.'));
  const user = b.messages[1].content;
  assert.ok(user.includes('3: Does drug X reduce fatigue') && user.includes(T.PAPER_CARD_TASK) && user.endsWith('Build the paper card.'));
  assert.ok(!user.includes('an earlier question'));
  assert.strictEqual(card.question, 'Does drug X reduce fatigue in adults with long COVID?');
  assert.strictEqual(T.paperForm.draft, card);
  assert.strictEqual(JSON.stringify(state.messages), chat);
  assert.strictEqual(JSON.stringify(env.storage), stored, 'nothing is stored before Save');
  assert.strictEqual(state.busy, false);
  // a sloppy answer that is no card: the error, no draft
  T.discardPaperCard();
  recordFetch(env, [muText('No card, sorry.')]);
  assert.strictEqual(await T.buildPaperCard(), null);
  assert.strictEqual(T.paperForm.error, 'The card did not come back as JSON. Try Rebuild.');
  assert.strictEqual(T.paperForm.draft, null);
  T.discardPaperCard();
});
