'use strict';
// find_relevant_sections (src/section-scores.js): when it is offered (long documents only), how the sections are cut
// (tiny ones merged, the cap), the section requests (no tools, the short instruction, the text clipped to the read
// limit), the ranked result, the progress text, Stop between sections, and a whole Munin turn with recorded streams.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, makeSnapFor } = require('./lib/sandbox');
const { docBench, useProvider, send, muTool, muText } = require('./lib/context');
const { sseResponse } = require('./lib/streams');

let env, T, state, snapFor, doc;
const names = (tools) => tools.map((t) => t.name || (t.function && t.function.name));
// A paragraph of about `words` words that names its section.
const para = (k, words) => Array.from({ length: words }, (_, i) => (i % 12 === 0 ? `s${k}` : 'lorem')).join(' ') + '.';
// n sections "## Section k", each of `words` words, filling the body to about `chars` characters.
function longDoc(n, chars = 14000, words = 200) {
  const out = [];
  for (let k = 1; k <= n; k++) {
    out.push(`## Section ${k}`, '');
    let body = '';
    while (body.length < chars) body += para(k, words) + '\n\n';
    out.push(body.trim(), '');
  }
  return out.join('\n');
}
const sectionOf = (body) => Number(/<section title="Section (\d+)/.exec(body.messages[1].content)[1]);
const scoreReply = (k) => muText(`Section ${k} discusses the topic. It gives detail ${k}.\nScore: ${k}`);
// A fetch that answers each section request with scoreReply(section) and records the bodies.
function scoringFetch(after) {
  const bodies = [];
  env.ctx.fetch = async (url, init) => {
    const b = JSON.parse(init.body);
    bodies.push(b);
    const r = sseResponse(scoreReply(sectionOf(b)));
    if (after) after(bodies.length);
    return r;
  };
  return bodies;
}
const setDoc = (text) => { state.docFormat = 'markdown'; state.docText = text; state.docModel = null; state.selection = ''; };

before(async () => {
  env = await load();
  ({ T, state } = env);
  snapFor = makeSnapFor(env);
  ({ doc } = docBench(env));
});

test('offered only when the text does not fit one request and the outline has 8+ headings', () => {
  setDoc(longDoc(10));
  let s = snapFor('munin');
  assert.ok(!T.docFitsRequest('edit', s));
  assert.ok(names(T.toolsFor('edit', s)).includes('find_relevant_sections'));
  assert.ok(names(T.toolsFor('manual', s)).includes('find_relevant_sections'));
  assert.ok(T.buildTurnContext('edit', s, null).includes('find_relevant_sections(question) ranks its sections'));
  // A larger window holds the same text: not offered.
  s = snapFor('openai');
  assert.ok(T.docFitsRequest('edit', s));
  assert.ok(!names(T.toolsFor('edit', s)).includes('find_relevant_sections'));
  // Short document; long document with few headings.
  setDoc('# Doc\n\n## A\n\nText.');
  s = snapFor('munin');
  assert.ok(!names(T.toolsFor('edit', s)).includes('find_relevant_sections'));
  assert.ok(!T.buildTurnContext('edit', s, null).includes('find_relevant_sections'));
  setDoc(longDoc(5, 28000));
  s = snapFor('munin');
  assert.ok(!T.docFitsRequest('edit', s));
  assert.ok(!names(T.toolsFor('edit', s)).includes('find_relevant_sections'));
  // Never in a document pass or a Munin persona turn.
  setDoc(longDoc(10));
  s = snapFor('munin');
  assert.ok(!names(T.toolsFor('review', s)).includes('find_relevant_sections'));
  deq(names(T.toolsFor('research', s)), []);
});

test('strict schema; the description names the cost', () => {
  deq(T.SECTION_TOOL.function.parameters, {
    type: 'object', properties: { question: { type: 'string', description: 'The user\'s question, in their words.' } },
    required: ['question'], additionalProperties: false,
  });
  assert.match(T.SECTION_TOOL.function.description, /one request per section \(about 1-3k tokens each\)/);
  assert.ok(T.SECTION_SCORE_PROMPT.length < 600, 'the instruction stays about 120 tokens');
});

test('sections: top-level headings, tiny ones merged with a neighbour, at most 24', () => {
  // 200, 50, 200, 200, 30 words: the 50-word section joins the next, the last (30) joins the one before.
  const sizes = [200, 50, 200, 200, 30];
  setDoc(['# Paper title', '', ...sizes.flatMap((w, i) => [`## Part ${i + 1}`, '', para(i + 1, w), ''])].join('\n'));
  let r = T.docSections(snapFor('munin'));
  deq(r.sections.map((s) => s.titles), [['Paper title', 'Part 1'], ['Part 2', 'Part 3'], ['Part 4', 'Part 5']]);
  assert.strictEqual(r.merged, 3); // the H1 title (2 words) joins Part 1
  deq([r.sections[0].start, r.sections[2].end], [1, 22]);
  // 30 sections of 200 words: joined down to 24.
  setDoc(['# T', '', ...Array.from({ length: 30 }, (_, i) => [`## P${i + 1}`, '', para(i + 1, 200), '']).flat()].join('\n'));
  r = T.docSections(snapFor('munin'));
  assert.strictEqual(r.sections.length, 24);
  assert.strictEqual(r.capped, 6);
  assert.strictEqual(r.sections.reduce((n, s) => n + s.titles.length, 0), 31); // nothing left out (the H1 joins P1)
});

test('score parsing', () => {
  deq(T.parseSectionScore('It covers the method.\nScore: 7'), { summary: 'It covers the method.', score: 7 });
  deq(T.parseSectionScore('Nothing on this question.\n**Score:** 0/10'), { summary: 'Nothing on this question.', score: 0 });
  deq(T.parseSectionScore('Summary.\nScore: 14'), { summary: 'Summary.', score: 10 });
  deq(T.parseSectionScore('No number here.'), { summary: 'No number here.', score: null });
});

test('10 sections scored and sorted; requests without tools, clipped to the read limit; progress per section', async () => {
  setDoc(longDoc(10));
  const s = snapFor('munin');
  const bodies = scoringFetch();
  const progress = [];
  s.onCallProgress = (t) => progress.push(t);
  const out = await T.findRelevantSections({ question: 'Where is the dose?' }, s);
  assert.strictEqual(bodies.length, 10);
  for (const b of bodies) {
    assert.strictEqual(b.messages[0].content, T.SECTION_SCORE_PROMPT);
    assert.strictEqual(b.tools, undefined);
    assert.strictEqual(b.persona, 'raw');
    deq(b.chat_template_kwargs, { reasoning_effort: 'low' });
    assert.ok(b.messages[1].content.startsWith('Question: Where is the dose?\n\n<section title="Section '));
    assert.ok(b.messages[1].content.length < 8000 + 200, 'Munin: clipped to readMaxChars');
  }
  deq(progress, Array.from({ length: 10 }, (_, i) => `Reading section ${i + 1} of 10`));
  const lines = out.split('\n');
  assert.match(lines[0], /^Sections ranked for the question "Where is the dose\?" \(10 of 10 scored, one request each\):$/);
  // Top five in full, by score (10 … 6), with line ranges and the clipping note.
  for (let i = 0; i < 5; i++) {
    const k = 10 - i;
    assert.match(lines[1 + i], new RegExp(`^${i + 1}\\. Lines \\d+–\\d+, «Section ${k}»: score ${k}/10 \\(only its first 8,000 characters were scored\\)\\. Section ${k} discusses the topic\\. It gives detail ${k}\\.$`));
  }
  assert.strictEqual(lines[6], 'Other sections:');
  for (let i = 0; i < 5; i++) {
    const k = 5 - i;
    assert.match(lines[7 + i], new RegExp(`^- Lines \\d+–\\d+, «Section ${k}»: score ${k}/10\\. Section ${k} discusses the topic\\.$`));
  }
  assert.match(lines[12], /read the best sections with read_lines/);
});

test('Stop after 3 sections: no more requests, the result says so', async () => {
  setDoc(longDoc(10));
  const s = snapFor('munin');
  const ac = new AbortController();
  s.signal = ac.signal;
  const bodies = scoringFetch((n) => { if (n === 3) ac.abort(); });
  const out = await T.findRelevantSections({ question: 'q' }, s);
  assert.strictEqual(bodies.length, 3);
  assert.match(out, /\(\d of 10 scored/);
  assert.match(out, /\[Stopped after \d of 10 sections\.\]/);
});

test('a failed request: the tool fails before the first score, ends with what was scored after it', async () => {
  setDoc(longDoc(10));
  let n = 0;
  env.ctx.fetch = async () => { n++; if (n === 1) return { ok: false, status: 400, text: async () => '{"error":{"message":"bad"}}', headers: { get: () => null } }; return sseResponse(scoreReply(1)); };
  await assert.rejects(T.findRelevantSections({ question: 'q' }, snapFor('munin')));
  n = 0;
  env.ctx.fetch = async () => { n++; if (n === 3) return { ok: false, status: 400, text: async () => '{"error":{"message":"bad"}}', headers: { get: () => null } }; return sseResponse(scoreReply(1)); };
  const out = await T.findRelevantSections({ question: 'q' }, snapFor('munin'));
  assert.match(out, /\(2 of 10 scored/);
  assert.match(out, /\[Scoring stopped at section 3 of 10: /);
});

test('OpenAI and Anthropic section requests: the instruction as system text, no tools, a small reply limit', () => {
  setDoc(longDoc(10));
  let r = T.sectionRequest(snapFor('openai', { model: 'gpt-6.1-sol' }), 'U');
  assert.strictEqual(r.kind, 'responses');
  deq([r.body.instructions, r.body.input, r.body.tools, r.body.reasoning], [T.SECTION_SCORE_PROMPT, [{ role: 'user', content: 'U' }], undefined, { effort: 'low' }]);
  r = T.sectionRequest(snapFor('anthropic'), 'U');
  assert.strictEqual(r.kind, 'anthropic');
  deq([r.body.system, r.body.messages, r.body.tools, r.body.thinking, r.body.max_tokens], [T.SECTION_SCORE_PROMPT, [{ role: 'user', content: 'U' }], undefined, undefined, 400]);
});

test('a whole Munin turn: the call, ten section requests, the ranked result goes back to the model', async () => {
  doc.text = longDoc(10);
  useProvider(env, 'munin');
  state.applyMode = 'manual';
  await T.refreshContext({ force: true });
  await T.createChat();
  const bodies = [];
  const rows = [];
  let main = 0;
  env.ctx.fetch = async (url, init) => {
    const b = JSON.parse(init.body);
    bodies.push(b);
    if (b.messages[0].content === T.SECTION_SCORE_PROMPT) {
      // The pending action-log row of the call shows the progress (and the orb's globe: the name says "find").
      const bubble = T.el.chat.children.filter((c) => c._rows).pop();
      rows.push(bubble ? bubble._rows.map((r) => r.innerHTML).join(' | ') : '');
      return sseResponse(scoreReply(sectionOf(b)));
    }
    main++;
    return sseResponse(main === 1 ? muTool('c1', 'find_relevant_sections', { question: 'Where is the dose?' }) : muText('Section 10 has it.'));
  };
  await send(env, 'Where is the dose?');
  assert.strictEqual(bodies.length, 12);
  assert.strictEqual(rows.length, 10);
  rows.forEach((r, i) => assert.ok(r.includes(`find_relevant_sections</span>: Reading section ${i + 1} of 10 ⏳`), r));
  assert.strictEqual(T.toolOrbMode('find_relevant_sections'), 'globe');
  assert.ok(names(bodies[0].tools).includes('find_relevant_sections'));
  const result = state.messages.find((m) => m.role === 'tool');
  // Stubbed after the turn like every reading result; the last request carried it whole.
  const sent = bodies[11].messages.find((m) => m.role === 'tool').content;
  assert.match(sent, /^Sections ranked for the question "Where is the dose\?" \(10 of 10 scored/);
  assert.match(sent, /\n1\. Lines \d+–\d+, «Section 10»: score 10\/10/);
  assert.ok(result && result._omittedChars > 0);
  assert.strictEqual(state.messages[state.messages.length - 1].content, 'Section 10 has it.');
});
