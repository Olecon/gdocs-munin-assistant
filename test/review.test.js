'use strict';
// /review: a PERSONAS entry run as a document pass. The request of every provider leaves the chat history out and
// carries the review head (static), the whole numbered document and the rubric in the user message, without tools;
// a long document gets the outline and the reading tools instead. Munin runs it in raw mode (never the persona
// pipeline). The finish hook stores the findings (_review) and their Markdown as the answer; an answer that is not
// findings stays as it came, with an error. Fix flagged: its message and when it is off.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, waitFor } = require('./lib/sandbox');
const { textRound } = require('./lib/streams');
const { docBench, recordFetch, useProvider, send, oaText, muText } = require('./lib/context');

let env, T, state, doc;
const DOC = '# Fatigue trial\n\nThe treatment cures fatigue in all patients.\n\n## Results\n\nFatigue scores fell by 12% (Table 1).';
const ANSWER = 'Here you go:\n```json\n{"criteria":{"claims":"FAIL","refs":"PASS",},"findings":[{"severity":"Major","criterion":"claims","quote":"The treatment cures fatigue","line":"L3","detail":"Stronger than the 12% drop.","action":"Say it reduced fatigue."},{"criterion":"support","quote":"fatigue in all patients","line":3,"status":"supported","evidence":{"quote":"Fatigue scores fell by 12%","line":7}},{"severity":"minor","criterion":"terms","quote":"not in the text at all","line":2,"detail":"x"},]}\n```';
const histKey = () => 'muninChatHistory:DOC123:' + state.chatId;
const userTexts = (msgs) => msgs.filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));

before(async () => {
  env = await load();
  ({ T, state } = env);
  ({ doc } = docBench(env));
  doc.text = DOC;
  await T.refreshContext({ force: true });
});

// A chat with one finished ordinary turn, so that there is a history the review must leave out.
async function chatWithOneTurn(prov) {
  useProvider(env, prov, prov === 'anthropic' ? { model: 'claude-opus-5-5' } : {});
  doc.text = DOC;
  await T.createChat();
  T.el.chat.children.length = 0;
  recordFetch(env, [prov === 'anthropic' ? textRound('Earlier answer.') : prov === 'openai' ? oaText('Earlier answer.') : muText('Earlier answer.')]);
  await send(env, 'an earlier question');
  assert.strictEqual(state.messages.length, 2);
}

test('/review is a slash command with a default text; the rubric names every criterion and stays near 400 tokens', () => {
  deq(T.parseSlashCommand('/review focus on the numbers'), { persona: 'review', text: 'focus on the numbers' });
  deq(T.parseSlashCommand('/Review'), { persona: 'review', text: 'Review this document.' }); // a bare command sends its default text
  assert.strictEqual(T.PERSONAS.review.defaultText, 'Review this document.');
  assert.ok(T.isDocPass('review') && T.isDocPass('card') && !T.isDocPass('research'));
  assert.ok(T.REVIEW_RUBRIC.length <= 1700, `rubric ${T.REVIEW_RUBRIC.length} characters`);
  for (const id of Object.keys(T.REVIEW_CRITERIA)) assert.ok(T.REVIEW_RUBRIC.includes(`\n${id}: `), id);
  for (const k of ['"severity"', '"criterion"', '"quote"', '"line"', '"detail"', '"action"', '"absence"', '"status"', '"evidence"']) assert.ok(T.REVIEW_RUBRIC.includes(k), k);
});

test('Munin: one raw-mode request without the chat history, tools or the persona pipeline; the findings are stored', async () => {
  await chatWithOneTurn('munin');
  const bodies = recordFetch(env, [muText(ANSWER)]);
  await send(env, '/review focus on the claims');
  assert.strictEqual(bodies.length, 1);
  const b = bodies[0];
  assert.strictEqual(b.persona, 'raw');
  assert.strictEqual(b.tools, undefined);
  deq(b.messages.map((m) => m.role), ['system', 'user']);
  const [system, user] = b.messages.map((m) => m.content);
  assert.ok(system.startsWith(T.DOC_PASS_HEADS.review) && system.includes(T.UNTRUSTED_DATA_NOTE));
  assert.ok(!system.includes('W1.') && !system.includes('remember(') && !system.includes(T.DOC_PASS_READ_NOTE));
  assert.ok(user.includes('<document title="My Doc" format="markdown" lines="7">\n1: # Fatigue trial\n2: \n3: The treatment cures fatigue in all patients.'));
  assert.ok(user.includes(T.REVIEW_RUBRIC) && user.endsWith('focus on the claims'));
  assert.ok(!JSON.stringify(b).includes('an earlier question') && !JSON.stringify(b).includes('Earlier answer.'));
  // the stored answer: the findings' Markdown, with the findings on _review
  const msgs = state.messages;
  assert.strictEqual(msgs.length, 4);
  deq([msgs[2]._persona, msgs[2].content], ['review', 'focus on the claims']);
  assert.ok(msgs[2]._context.includes('<document') && !msgs[2]._context.includes(T.REVIEW_RUBRIC), 'the stored context is the ordinary one');
  const reply = msgs[3];
  assert.ok(reply.content.startsWith('**Review**: 1 major, 1 supported, 1 unverified'));
  deq(reply._review.findings.map((f) => [T.findingGroup(f), f.line, f.verified]), [['major', 3, true], ['ok', 3, true], ['unverified', 2, false]]);
  deq(reply._review.criteria, { claims: 'FAIL', refs: 'PASS' }); // an unverified finding does not fail its criterion
  assert.ok(JSON.stringify(env.storage[histKey()]).includes('"_review"'));
  // the next ordinary turn sends the review as a normal exchange: the Markdown, not the rubric or the numbered text
  const next = recordFetch(env, [muText('ok')]);
  await send(env, 'thanks');
  const sent = JSON.stringify(next[0].messages);
  assert.ok(sent.includes('focus on the claims') && sent.includes('**Review**: 1 major'));
  assert.ok(!sent.includes('Review task.'), 'rubric');
  assert.ok(!sent.includes('3: The treatment cures'), 'the numbered text');
});

test('OpenAI and Anthropic: the same single request (only the review message, no tools)', async () => {
  await chatWithOneTurn('openai');
  let bodies = recordFetch(env, [oaText(ANSWER)]);
  await send(env, '/review all of it');
  assert.strictEqual(bodies.length, 1);
  assert.strictEqual(bodies[0].tools, undefined);
  assert.ok(bodies[0].instructions.startsWith(T.DOC_PASS_HEADS.review));
  deq(userTexts(bodies[0].input).length, 1);
  assert.ok(state.messages[state.messages.length - 1]._review);

  await chatWithOneTurn('anthropic');
  bodies = recordFetch(env, [textRound(ANSWER)]);
  await send(env, '/review all of it');
  assert.strictEqual(bodies.length, 1);
  assert.strictEqual(bodies[0].tools, undefined);
  assert.strictEqual(bodies[0].messages.length, 1);
  assert.ok(bodies[0].system[0].text.startsWith(T.DOC_PASS_HEADS.review));
  assert.ok(JSON.stringify(bodies[0].messages[0].content).includes('Review task.'));
  assert.ok(state.messages[state.messages.length - 1].content.startsWith('**Review**'));
});

test('a long document: the outline and the reading tools, read in parts; the head says so', async () => {
  useProvider(env, 'munin');
  const body = Array.from({ length: 6000 }, (_, i) => `Sentence number ${i + 1} of the long results section is here.`).join('\n');
  doc.text = `# Long paper\n## Results\n${body}`;
  await T.refreshContext({ force: true });
  await T.createChat();
  await T.fetchDocText();
  const snap = T.takeSnapshot();
  T.snapshotDocument(snap);
  state.messages = [{ role: 'user', content: 'Review this document.', _persona: 'review', _context: T.buildTurnContext('review', snap, null) }];
  const req = T.buildRequest('review', snap);
  deq(req.body.tools.map((t) => t.function.name), ['get_outline', 'read_lines', 'find_in_document', 'get_selection']);
  const [system, user] = req.body.messages.map((m) => m.content);
  assert.ok(system.includes(T.DOC_PASS_READ_NOTE));
  assert.ok(user.includes('Outline (line: heading):\nL1: # Long paper\nL2: ## Results'));
  assert.ok(user.includes('[The document is too long for one message (6,002 lines): read it in parts with read_lines.]'));
  assert.ok(user.includes(T.REVIEW_RUBRIC) && !user.includes('Sentence number 3000'));
  // every round of the turn sends the same tools and head
  deq(T.buildRequest('review', snap).body.messages[0], req.body.messages[0]);
  doc.text = DOC;
  await T.refreshContext({ force: true });
});

test('an answer that is not findings stays as it came, with an error; nothing is stored on _review', async () => {
  await chatWithOneTurn('munin');
  recordFetch(env, [muText('I am sorry, I cannot review this.')]);
  await send(env, '/review please');
  const reply = state.messages[state.messages.length - 1];
  assert.strictEqual(reply.content, 'I am sorry, I cannot review this.');
  assert.strictEqual(reply._review, undefined);
  await waitFor(() => T.el.chat.children.some((c) => c.classList && c.classList.contains('error') && String(c.innerHTML).includes('The review did not come back as findings.')), 'the error');
});

test('Fix flagged: the message lists the flagged findings with lines and quotes; off outside Auto with the Docs API', () => {
  const findings = T.reviewResult(ANSWER, { docText: DOC }).findings;
  const text = T.fixFlaggedText(T.flaggedFindings(findings));
  assert.strictEqual(text, 'Fix the flagged findings:\n1. Line 3, «The treatment cures fatigue»: Stronger than the 12% drop. Fix: Say it reduced fatigue.\n' +
    'Change only those places, one edit per finding; keep every number and citation.');
  const keep = { applyMode: state.applyMode, googleConnected: state.googleConnected, docFormat: state.docFormat };
  try {
    Object.assign(state, { applyMode: 'manual', googleConnected: true, docFormat: 'docs-api' });
    deq(T.fixFlaggedState(), { ok: false, reason: 'Fix flagged edits the document: switch to Edit automatically first.' });
    Object.assign(state, { applyMode: 'plan', googleConnected: true, docFormat: 'docs-api' }); // Plan refuses writes like Manual
    deq(T.fixFlaggedState(), { ok: false, reason: 'Fix flagged edits the document: switch to Edit automatically first.' });
    Object.assign(state, { applyMode: 'auto', googleConnected: false, docFormat: 'markdown' });
    deq(T.fixFlaggedState(), { ok: false, reason: 'Fix flagged needs the Google Docs API: sign in with Google in Settings.' });
    Object.assign(state, { applyMode: 'auto', googleConnected: true, docFormat: 'docs-api' });
    deq(T.fixFlaggedState(), { ok: true, reason: '' });
  } finally {
    Object.assign(state, keep);
  }
});

test('an answer cut by the length limit: the continuation carries on the JSON; the findings go on the last part', async () => {
  await chatWithOneTurn('munin');
  const cc = (o) => `data: ${JSON.stringify(o)}\n\n`;
  const cut = (t) => cc({ choices: [{ index: 0, delta: { content: t } }] }) + cc({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }) + 'data: [DONE]\n\n';
  const at = ANSWER.indexOf('{"criterion":"support"');
  const bodies = recordFetch(env, [cut(ANSWER.slice(0, at)), muText(ANSWER.slice(at))]);
  await send(env, '/review all');
  assert.strictEqual(bodies.length, 2); // the automatic continuation
  const turn = state.messages.slice(state.messages.findIndex((m) => m.content === 'all'));
  const answers = turn.filter((m) => m.role === 'assistant');
  assert.strictEqual(answers.length, 2);
  assert.strictEqual(answers[0].content, '');
  assert.strictEqual(answers[1]._review.findings.length, 3);
  assert.ok(answers[1].content.startsWith('**Review**: 1 major, 1 supported, 1 unverified'));
});

test('the beforeTurn lines (hidden text) stay next to the document in the review request', () => {
  useProvider(env, 'munin');
  const snap = T.takeSnapshot();
  T.snapshotDocument(snap);
  snap.turnLines = ['Hidden text: line 3 holds 2 zero-width characters.'];
  const ctx = T.docPassContext('review', snap, '');
  assert.ok(ctx.includes('</document>\nHidden text: line 3 holds 2 zero-width characters.\n\nReview task.'));
});
