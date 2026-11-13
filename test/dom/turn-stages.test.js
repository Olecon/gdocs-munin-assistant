'use strict';
// One message per turn (render.js: the rounds of addAssistantBubble, syncStages, renderHistory): the turn's tool rounds
// are stages of ONE assistant bubble; the activity (one stage per round) comes before the answer, the head line (the
// final answer); each round has its action row (one call: that call's row; several: "Actions N", folded), every call
// row folds to its details; Undo of the latest edit on its round's action row; the same structure after a reload, the
// open states kept. A round's own text stands above its action row (it came before the calls), live from the moment its
// call comes and after the end alike; the answer slot holds the reply after the last calls; the meta line waits for
// the end of the turn. One text is drawn once: an interim text that repeats the round's before it is not drawn again.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { load, click, tick } = require('../lib/dom-sandbox');

let env, T, state, el;
before(async () => {
  env = await load();
  ({ T, state, el } = env);
  state.googleConnected = true;
});
after(() => env.close());

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const edit = (id, extra) => ({ id, kind: 'format', index: 9, text: 'x', restore: '', paras: [], undone: false, ...extra });
const bubbles = () => [...el.chat.querySelectorAll('.msg.assistant')];
const shown = (n) => !!n && !n.classList.contains('hidden') && !n.closest('.hidden');
const stagesOf = (b) => [...b.querySelectorAll('.activity-rows > .stage')].filter((s) => !s.classList.contains('hidden'));
const lineOf = (s) => s.querySelector(':scope > .stage-head > .stage-line');
const headText = (s) => (s.querySelector('.stage-head').classList.contains('hidden') ? null : lineOf(s).textContent);

// Three tool rounds (two reads; one insert; two formats, the latest edit), then the answer.
function history({ final = 'All set.' } = {}) {
  const h = [
    { role: 'user', content: 'Format the list.' },
    { role: 'assistant', content: 'Let me read it first.', tool_calls: [call('a1', 'read_lines', { start: 1, end: 3 }), call('a2', 'get_outline', {})] },
    { role: 'tool', tool_call_id: 'a1', content: 'Lines 1-3', _ok: true, _reading: true },
    { role: 'tool', tool_call_id: 'a2', content: 'Outline', _ok: true, _reading: true },
    { role: 'assistant', content: null, tool_calls: [call('b1', 'insert_after_line', { line: 3, text: 'Item' })], _usage: { total_tokens: 100, prompt_tokens: 90, completion_tokens: 10 } },
    { role: 'tool', tool_call_id: 'b1', content: 'Done: inserted.', _ok: true, _message: 'Inserted after line 3', _cardText: 'Item', _edit: edit('b1', { kind: 'insert' }) },
    { role: 'assistant', content: null, tool_calls: [call('c1', 'format_lines', { start: 4, end: 4, bold: true }), call('c2', 'format_lines', { start: 5, end: 5, bold: true })] },
    { role: 'tool', tool_call_id: 'c1', content: 'Done: formatted line 4.', _ok: true, _message: 'Formatted line 4', _edit: edit('c1') },
    { role: 'tool', tool_call_id: 'c2', content: 'Done: formatted line 5.', _ok: true, _message: 'Formatted line 5', _edit: edit('c2') },
  ];
  if (final) h.push({ role: 'assistant', content: final, _usage: { total_tokens: 50, prompt_tokens: 45, completion_tokens: 5 } });
  return h;
}

test('a three-round turn is one bubble with three stages, each with its action row; the final answer under them', () => {
  state.messages = history();
  T.renderHistory();
  assert.strictEqual(bubbles().length, 1);
  const b = bubbles()[0];
  assert.strictEqual(b.querySelector('.md').textContent.trim(), 'All set.');
  assert.ok(b.querySelector('.activity').compareDocumentPosition(b.querySelector('.msg-answer')) & 4, 'the stages first, the answer under them');
  assert.strictEqual(b.querySelector('.tool-group'), null, 'no per-turn group row');
  assert.ok(shown(b.querySelector('.activity-rows')), 'the stages are in view');
  const stages = stagesOf(b);
  assert.strictEqual(stages.length, 3);
  // a round with several calls: "Actions N", folded; a round with one call: that call's row only
  assert.deepStrictEqual(stages.map(headText), ['Actions 2', null, 'Actions 2']);
  assert.deepStrictEqual(stages.map((s) => shown(s.querySelector('.stage-rows'))), [false, true, false]);
  assert.deepStrictEqual(stages.map((s) => s.querySelectorAll('.activity-row').length), [2, 1, 2]);
  // the round's own text (not the head line) stays in its stage
  assert.strictEqual(stages[0].querySelector('.stage-text').textContent, 'Let me read it first.');
  assert.ok(!b.querySelector('.md').textContent.includes('Let me read'));
  assert.strictEqual(b.querySelector('.msg-meta').textContent, '150 tokens'); // the turn's requests
});

test('the stages fold on their own: opening one leaves the other folded', async () => {
  const b = bubbles()[0];
  const [s1, s2, s3] = stagesOf(b);
  const rows = (s) => s.querySelector('.stage-rows');
  assert.ok(!shown(rows(s1)) && !shown(rows(s3)), 'multi-call stages are folded');
  assert.ok(shown(rows(s2)), 'a one-call stage is its row');
  click(lineOf(s3));
  await tick();
  assert.ok(shown(rows(s3)) && !shown(rows(s1)));
  assert.strictEqual(lineOf(s3).getAttribute('aria-expanded'), 'true');
  click(lineOf(s1));
  click(lineOf(s3));
  await tick();
  assert.ok(shown(rows(s1)) && !shown(rows(s3)));
});

test('a call inside a stage folds to its details: arguments and result, the write\'s What was done', async () => {
  const b = bubbles()[0];
  const [s1, , s3] = stagesOf(b);
  const read = s1.querySelector('details.activity-row.log-row');
  assert.ok(read && !read.open);
  click(read.querySelector('summary'));
  await tick();
  assert.ok(read.open);
  assert.match(read.querySelector('.log-body').textContent, /Arguments[\s\S]*start: 1[\s\S]*Result[\s\S]*Lines 1-3/);
  if (lineOf(s3).getAttribute('aria-expanded') !== 'true') { click(lineOf(s3)); await tick(); }
  const fold = s3.querySelectorAll('.write-row')[1].querySelector('details.log-fold');
  click(fold.querySelector('summary'));
  await tick();
  assert.ok(fold.open);
  assert.strictEqual(fold.querySelector('.log-what').textContent, 'Formatted line 5');
});

test('Undo on the action row of the round with the latest edit (Undo all for the turn\'s edits); its own row keeps the same control', async () => {
  const b = bubbles()[0];
  const acts = [...stagesOf(b)[2].querySelectorAll('.stage-head > .row-acts > .row-act')];
  assert.strictEqual(stagesOf(b)[0].querySelector('.stage-head .row-act'), null);
  assert.deepStrictEqual(acts.map((x) => [x.dataset.act, x.dataset.edit]), [['undo-edit', 'c2'], ['undo-all', 'c2']]);
  assert.ok(b.querySelector('.write-row [data-act="undo-edit"][data-edit="c2"]'));
  const seen = [];
  env.ctx.__seenUndo = seen;
  env.ctx.__prevUndo = env.get('undoFromButton');
  env.run('undoFromButton = (id, btn) => { __seenUndo.push([id, btn.dataset.act]); return Promise.resolve(true); }');
  try {
    click(acts[0]);
    await tick();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(seen)), [['c2', 'undo-edit']]);
  } finally { env.run('undoFromButton = __prevUndo'); }
  // undone: the round's action row says so and offers the edit before
  state.messages[8]._edit.undone = true;
  T.renderHistory();
  const g = stagesOf(bubbles()[0])[2].querySelector('.stage-head');
  assert.strictEqual(g.querySelector('.stage-line').textContent, 'Actions 2 · Undone');
  assert.deepStrictEqual([...g.querySelectorAll('.row-act')].map((x) => x.dataset.edit), ['c1', 'c1']);
  state.messages[8]._edit.undone = false;
});

test('without a final text the last round\'s action row ends the bubble', () => {
  state.messages = history({ final: '' });
  T.renderHistory();
  const b = bubbles()[0];
  assert.ok(b.querySelector('.md').classList.contains('hidden'));
  assert.strictEqual(headText(stagesOf(b)[2]), 'Actions 2');
  assert.strictEqual(b._text, ''); // the first round's text is no answer: it stays in its stage
  assert.strictEqual(stagesOf(b)[0].querySelector('.stage-text').textContent, 'Let me read it first.');
});

test('the same structure after a reload (renderHistory), with the open stage kept', async () => {
  state.messages = history();
  T.renderHistory();
  let b = bubbles()[0];
  const s1 = stagesOf(b)[0];
  if (lineOf(s1).getAttribute('aria-expanded') === 'true') { click(lineOf(s1)); await tick(); }
  const s3 = stagesOf(b)[2];
  if (lineOf(s3).getAttribute('aria-expanded') !== 'true') { click(lineOf(s3)); await tick(); }
  const shape = (x) => ({ text: x.querySelector('.md').textContent.trim(),
    stages: stagesOf(x).map((s) => [headText(s), lineOf(s).getAttribute('aria-expanded'), s.querySelectorAll('.activity-row').length, shown(s.querySelector('.stage-rows'))]) });
  const before = shape(b);
  el.chat.textContent = '';
  T.renderHistory();
  b = bubbles()[0];
  assert.strictEqual(bubbles().length, 1);
  assert.deepStrictEqual(shape(b), before);
  assert.strictEqual(before.stages[2][3], true); // the stage opened above is still open
  assert.strictEqual(before.stages[0][3], false);
});

test('turns stay apart: each user message starts a new bubble; the panel\'s own requests (_auto) do not', () => {
  state.messages = [
    ...history(),
    { role: 'user', content: 'Again.' },
    { role: 'assistant', content: 'Part one, pa' },
    { role: 'user', content: '[continue]', _auto: true },
    { role: 'assistant', content: 'rt two.' },
  ];
  T.renderHistory();
  assert.strictEqual(bubbles().length, 2);
  assert.match(bubbles()[1]._text, /^Part one, pa\n\nrt two\.$/); // the answer and its continuation are the head line
});

// The bubble's texts and action rows as shown, in order: 'text:<text>' (a round's own text or the answer), 'row:<row>'.
const timeline = (b) => [...b.querySelectorAll('.stage-text, .stage-rows > .activity-row, .stage-line, .msg-answer > .md')]
  .filter((n) => shown(n) && n.textContent.trim())
  .map((n) => (n.matches('.stage-text, .md') ? 'text:' : 'row:') + (n.querySelector(':scope > summary') || n).textContent.trim());

test('live: a round\'s text stands above its call\'s row once the call comes, where it was written; the answer slot holds the reply after the last calls; the end moves nothing', () => {
  el.chat.textContent = '';
  const b = T.addAssistantBubble();
  b._live = true; // liveAnswer's ensureBubble
  const md = () => b.querySelector('.md').textContent.trim();
  const done = (id, name) => ({ id, log: true, name, summary: '', args: {}, result: 'ok', status: 'ok' });
  T.updateAssistantBubble(b, { streaming: true, last: 'text', text: 'Let me read it' });
  assert.strictEqual(md(), 'Let me read it', 'a text that streams is the answer until a call comes');
  assert.deepStrictEqual(timeline(b), ['text:Let me read it']);
  // the stream writes a call: the text leads its round's stage (the answer slot is empty), the row comes under it
  T.updateAssistantBubble(b, { streaming: true, last: 'call', text: 'Let me read it first.', calling: 'read_lines' });
  const s1 = stagesOf(b)[0];
  assert.strictEqual(s1.querySelector('.stage-text').textContent, 'Let me read it first.');
  assert.ok(b.querySelector('.msg-answer').classList.contains('hidden'));
  assert.ok(s1.classList.contains('lead-text'), 'the round is led by its text (sidepanel.css: the answer\'s place)');
  T.updateAssistantBubble(b, { text: 'Let me read it first.', activity: [done('a1', 'read_lines')], usage: { total_tokens: 10 } });
  assert.deepStrictEqual(timeline(b), ['text:Let me read it first.', 'row:read_lines'], 'the text above its call\'s row');
  assert.strictEqual(s1.firstElementChild, s1.querySelector('.stage-text'));
  T.startAssistantRound(b);
  T.updateAssistantBubble(b, { streaming: true, last: 'text', text: 'All' });
  assert.strictEqual(md(), 'All');
  T.updateAssistantBubble(b, { text: 'All set.', usage: { total_tokens: 5 } });
  const live = timeline(b);
  assert.deepStrictEqual(live, ['text:Let me read it first.', 'row:read_lines', 'text:All set.']);
  assert.strictEqual(b._text, 'All set.');
  assert.ok(b.querySelector('.activity').compareDocumentPosition(b.querySelector('.msg-answer')) & 4);
  assert.ok(b.querySelector('.msg-meta').classList.contains('hidden'), 'no meta line while the turn runs');
  // the end: the same order, the meta line shows
  T.endAssistantBubble(b, { workedMs: 2000 });
  assert.deepStrictEqual(timeline(b), live, 'the end moves nothing');
  assert.strictEqual(md(), 'All set.');
  assert.strictEqual(b.querySelector('.msg-meta').textContent, '15 tokens');
  assert.ok(!b.querySelector('.msg-meta').classList.contains('hidden'));
});

test('a server\'s rows (a persona, a web search) came before the text that answers them: that text stays the answer, under them', () => {
  el.chat.textContent = '';
  const b = T.addAssistantBubble();
  T.updateAssistantBubble(b, { text: 'Three papers match.', activity: [{ name: 'web_search', summary: 'lipid rafts' }] });
  assert.deepStrictEqual(timeline(b), ['row:web_search: lipid rafts', 'text:Three papers match.']);
  assert.strictEqual(b._text, 'Three papers match.');
});

test('a turn stopped after a round that spoke and called a tool keeps that text above its row, where it arose', () => {
  state.messages = history({ final: '' });
  T.renderHistory();
  const b = bubbles()[0];
  assert.deepStrictEqual(timeline(b).slice(0, 2), ['text:Let me read it first.', 'row:Actions 2']);
  assert.ok(b.querySelector('.msg-answer').classList.contains('hidden'));
});

// The owner's chat: four rounds with the same interim text and the same reading call (the results alternate between the
// reading and "Already read in this message"), a fifth round with the call alone, then the answer.
const SAME = 'Структура готова. Проверю финальное состояние.';
function repeatHistory() {
  const read = (id) => call(id, 'read_document', { include: ['headings'], scope: { start: 22, end: 92 } });
  const h = [{ role: 'user', content: 'Проверь структуру.' }];
  for (let i = 1; i <= 5; i++) {
    h.push({ role: 'assistant', content: i <= 4 ? SAME : null, tool_calls: [read(`r${i}`)] });
    h.push({ role: 'tool', tool_call_id: `r${i}`, content: i % 2 ? '10 headings in lines 22-92' : 'Already read in this message; the document has not changed since: see the earlier result.', _ok: true, _reading: true });
  }
  h.push({ role: 'assistant', content: 'Что было сделано: заголовки исправлены.' });
  return h;
}

test('one text drawn once: the same interim text in consecutive rounds shows once, where it first arose; each round keeps its row', () => {
  state.messages = repeatHistory();
  T.renderHistory();
  const b = bubbles()[0];
  const t = timeline(b);
  assert.deepStrictEqual(t.filter((x) => x.startsWith('text:')), ['text:' + SAME, 'text:Что было сделано: заголовки исправлены.']);
  assert.deepStrictEqual(t.filter((x) => x.startsWith('row:')).length, 5, JSON.stringify(t));
  assert.strictEqual(t[0], 'text:' + SAME);
  assert.strictEqual(t[t.length - 1], 'text:Что было сделано: заголовки исправлены.');
  const stages = stagesOf(b);
  assert.strictEqual(stages.length, 5);
  assert.deepStrictEqual(stages.map((s) => shown(s.querySelector('.stage-text'))), [true, false, false, false, false]);
  assert.deepStrictEqual(stages.map((s) => s.classList.contains('lead-text')), [true, false, false, false, false]);
});

test('one text drawn once, live: a repeat waits while it streams (it never flashes in), a new text shows; a repeat after a round without text is a repeat too', () => {
  el.chat.textContent = '';
  const b = T.addAssistantBubble();
  b._live = true;
  const read = (id) => ({ id, log: true, name: 'read_document', summary: '', args: {}, result: 'ok', status: 'ok' });
  const texts = () => timeline(b).filter((x) => x.startsWith('text:'));
  T.updateAssistantBubble(b, { text: SAME, activity: [read('a')] });
  T.startAssistantRound(b);
  T.updateAssistantBubble(b, { streaming: true, last: 'text', text: 'Структура' }); // the start of the same sentence
  assert.deepStrictEqual(texts(), ['text:' + SAME], 'the repeat does not show while it streams');
  assert.ok(b.querySelector('.msg-answer').classList.contains('hidden'));
  T.updateAssistantBubble(b, { streaming: true, last: 'call', text: SAME, calling: 'read_document' });
  T.updateAssistantBubble(b, { text: SAME, activity: [read('b')] });
  assert.deepStrictEqual(texts(), ['text:' + SAME]);
  T.startAssistantRound(b);
  T.updateAssistantBubble(b, { activity: [read('c')] }); // a round with the call alone
  T.startAssistantRound(b);
  T.updateAssistantBubble(b, { text: `  ${SAME}\n`, activity: [read('d')] }); // the same, but for spacing
  assert.deepStrictEqual(texts(), ['text:' + SAME]);
  T.startAssistantRound(b);
  T.updateAssistantBubble(b, { streaming: true, last: 'text', text: 'Структура исправлена.' }); // starts alike, then differs
  assert.deepStrictEqual(texts(), ['text:' + SAME, 'text:Структура исправлена.']);
  T.endAssistantBubble(b);
  assert.deepStrictEqual(timeline(b).filter((x) => x.startsWith('row:')).length, 4, 'every round keeps its row');
  assert.deepStrictEqual(texts(), ['text:' + SAME, 'text:Структура исправлена.']);
});
