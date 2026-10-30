'use strict';
// The /research report skeleton (PERSONAS.research.report: OpenAI and Anthropic tools-mode turns only, never Munin's
// persona pipeline or the Auto/Manual head) and the pure parts of src/followups.js: the key findings check, the sources
// the answer did not use, the chip titles and the message a chip sends.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, makeSnapFor } = require('./lib/sandbox');

let env, T, state, snapFor;
const SKELETON = 'Key findings (bullets, each with its source link)';

before(async () => {
  env = await load();
  ({ T, state } = env);
  snapFor = makeSnapFor(env);
  state.docFormat = 'markdown'; state.docText = '# Doc\n\nText.'; state.docModel = null; state.selection = '';
});

test('the skeleton is in the /research instructions of OpenAI and Anthropic, and nowhere else', () => {
  assert.ok(T.PERSONAS.research.report.length < 400, 'about 80 tokens');
  assert.ok(T.buildRequest('research', snapFor('openai')).body.instructions.includes(SKELETON));
  assert.ok(T.buildRequest('research', snapFor('anthropic')).body.system[0].text.includes(SKELETON));
  assert.ok(T.PERSONAS.research.report.includes('"abstract only"'));
  // Munin: its own research pipeline (the persona request carries the instructions in the user message).
  const mu = T.buildRequest('research', snapFor('munin'));
  assert.strictEqual(mu.kind, 'persona');
  assert.ok(!JSON.stringify(mu.body.messages).includes('Key findings'));
  // Other personas and the Auto / Manual heads.
  for (const [mode, prov] of [['chat', 'openai'], ['code', 'anthropic'], ['edit', 'openai'], ['manual', 'anthropic'], ['edit', 'munin'], ['manual', 'munin']]) {
    assert.ok(!T.joinSystem(T.buildSystemParts(mode, 1e6, snapFor(prov))).includes('Key findings'), `${mode}/${prov}`);
  }
});

const SOURCES = [
  { url: 'https://example.org/a', title: 'Lipid rafts in membranes' },
  { url: 'https://www.nature.com/articles/b', title: 'Raft dynamics | Nature' },
  { url: 'https://example.org/c', title: '' },
];
const ANSWER = [
  '**TL;DR:** Rafts exist but are small.',
  '',
  '## Key findings',
  '- Rafts are ordered domains ([Lipid rafts in membranes](https://example.org/a)).',
  '- They last microseconds (nature.com).',
  '- They are smaller than 20 nm.',
  '  with a continuation line and https://example.org/x',
  '- Cholesterol drives them.',
  '',
  '## Details',
  '- A bullet outside the section without a link.',
  '',
  '## Caveats',
  'Abstract only for one source.',
].join('\n');

test('key findings: the bullets of the section, continuations joined; the unlinked ones counted', () => {
  deq(T.keyFindings(ANSWER), [
    '- Rafts are ordered domains ([Lipid rafts in membranes](https://example.org/a)).',
    '- They last microseconds (nature.com).',
    '- They are smaller than 20 nm. with a continuation line and https://example.org/x',
    '- Cholesterol drives them.',
  ]);
  assert.strictEqual(T.unlinkedFindings(ANSWER, SOURCES), 1); // the host of a cited source counts as its link
  assert.strictEqual(T.unlinkedFindings(ANSWER, []), 2);
  // A bold heading with a colon, a Russian heading, numbered bullets; no section at all.
  assert.strictEqual(T.unlinkedFindings('**Key findings:**\n1. One [a](https://a.org).\n2. Two.\n\n**Details**\n- Three.'), 1);
  assert.strictEqual(T.unlinkedFindings('### Ключевые выводы\n- Первый.\n- Второй (https://a.org).\n### Подробности\n- Третий.'), 1);
  assert.strictEqual(T.unlinkedFindings('A plain answer without sections.\n- a bullet'), 0);
});

test('unused sources: not mentioned by URL or title; at most three; short titles', () => {
  const text = 'See [Lipid rafts in membranes](https://example.org/a/) and Raft dynamics.';
  deq(T.unusedSources(text, SOURCES), [SOURCES[2]]); // a: URL (trailing slash), b: its short title
  deq(T.unusedSources('nothing', SOURCES).length, 3);
  const many = Array.from({ length: 5 }, (_, i) => ({ url: `https://e${i}.org/`, title: `Paper number ${i}` }));
  deq(T.unusedSources('Paper number 1 says so.', many).map((s) => s.title), ['Paper number 0', 'Paper number 2', 'Paper number 3']);
  assert.strictEqual(T.shortSourceTitle(SOURCES[1]), 'Raft dynamics');
  assert.strictEqual(T.shortSourceTitle(SOURCES[2]), 'example.org');
  assert.strictEqual(T.shortSourceTitle({ url: 'https://x.org', title: 'Long - Wikipedia' }), 'Long - Wikipedia'); // too little left
  const long = T.shortSourceTitle({ url: 'https://x.org', title: 'A very long title of a paper that goes on and on about membranes and rafts' });
  assert.ok(long.length <= 61 && long.endsWith('…'), long);
});

test('the message a chip sends: English, or Russian when the question is mostly Cyrillic', () => {
  assert.strictEqual(T.followupText('Raft dynamics', 'How long do lipid rafts live?'), '/research What does «Raft dynamics» add to the question: How long do lipid rafts live?');
  assert.strictEqual(T.followupText('Raft dynamics', 'Сколько живут lipid rafts?'), '/research Что добавляет «Raft dynamics» к вопросу: Сколько живут lipid rafts?');
  assert.ok(T.followupText('T', 'word '.repeat(80)).length < 220);
});
