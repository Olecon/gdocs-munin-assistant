'use strict';
// ask_user on a real DOM (jsdom): the answer buttons of the question card are real buttons that decide it on a
// click (the card's own handler; the chat's click delegation knows only data-act buttons), the decided card
// hides its buttons; the answers are a numbered list; the questionnaire of several questions (one at a time, the
// numbers, going back, the Other field with Enter, Send, the keyboard), multiple questions (toggles, Apply), and the auto-continue of a stored history is a row of the turn's bubble, not a user bubble.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { load, click, key, typeInto } = require('../lib/dom-sandbox');
const { waitFor } = require('../lib/sandbox');

let env, T, el;
const $$ = (sel) => [...el.chat.querySelectorAll(sel)];

before(async () => {
  env = await load();
  ({ T, el } = env);
});

const ONE = { questions: [{ question: 'Which <tone>?', options: ['Formal', 'Casual & short'] }] };
const THREE = { questions: [{ question: 'Which spin labels?', options: ['MTSL', 'TEMPO'] }, { question: 'Which force field?', options: ['AMBER', 'CHARMM', 'OPLS'] },
  { question: 'How do you validate them?', options: [] }] };
const askCall = (id, args = ONE) => ({ id, type: 'function', function: { name: 'ask_user', arguments: JSON.stringify(args) } });
// Starts an ask_user call and returns its promise and waiting card.
async function startAsk(args, mode = 'manual') {
  const s = T.takeSnapshot();
  const ac = new AbortController();
  s.signal = ac.signal;
  const p = T.executeTool(askCall('q' + Math.random(), args), mode, s, {});
  await waitFor(() => $$('.tool-card.preview.ask:not(.decided)').length === 1, 'the question card');
  return { p, card: $$('.tool-card.preview.ask:not(.decided)')[0], ac };
}
const labels = (card) => [...card.querySelectorAll('button')].map((b) => b.textContent);
const steps = (card) => [...card.querySelectorAll('.ask-step')].map((b) => b.textContent + (b.classList.contains('current') ? '*' : '') +
  (b.classList.contains('done') ? '+' : '') + (b.disabled ? '-' : '')).join(' ');

test('the answers are a numbered list, one button per line; clicking one decides the card; no chat button', async () => {
  el.chat.textContent = '';
  const s = T.takeSnapshot();
  s.signal = new AbortController().signal;
  const p = T.executeTool(askCall('a1'), 'manual', s, {});
  await waitFor(() => $$('.tool-card.preview.ask').length === 1, 'the question card');
  const card = $$('.tool-card.preview.ask')[0];
  assert.strictEqual(card.querySelector('.pv-note').textContent, 'Which <tone>?'); // escaped, shown as text
  assert.deepStrictEqual([...card.querySelectorAll('button')].map((b) => b.textContent), ['1. Formal', '2. Casual & short']);
  // stacked: each answer is its own child of the list, which the stylesheet lays out as a column
  const list = card.querySelector('.ask-options');
  assert.deepStrictEqual([...list.children].map((b) => [b.tagName, b.className.includes('ask-option')]), [['BUTTON', true], ['BUTTON', true]]);
  assert.match(require('fs').readFileSync(require('path').join(__dirname, '../../sidepanel.css'), 'utf8'), /\.tool-card\.ask \.ask-options \{ flex-direction: column;/);
  assert.strictEqual(card.querySelector('[data-ask="chat"]'), null);
  assert.strictEqual(card.querySelector('.ask-end'), null); // one single question: no Send until Other has text
  click(card.querySelectorAll('button')[1]);
  let r = await p;
  assert.strictEqual(r.content, 'The user answered:\n1. Which <tone>? \u2014 Casual & short');
  assert.strictEqual(r._decision, 'answered');
  // the card turns into its answered row in place: "ask_user · Chosen: … · <the question>", the question in its fold,
  // no buttons, no box
  assert.ok(card.isConnected && card.classList.contains('answered-row') && !card.classList.contains('tool-card') && !card.classList.contains('ok'));
  assert.strictEqual(card.querySelectorAll('button').length, 0);
  assert.strictEqual(card.querySelector('summary').textContent, 'ask_user · Chosen: Casual & short · Which <tone>?');
  assert.strictEqual(card.querySelector('details.log-fold').open, false);
  assert.strictEqual(card.querySelector('.log-body .log-asked').textContent, 'Which <tone>?');
  assert.strictEqual(T.pendingPreviews.size, 0);
});

test('one question with Other: typing shows Send and a click on an answer no longer sends; Enter in Other sends the text', async () => {
  el.chat.textContent = '';
  let { p, card } = await startAsk(ONE);
  const input = card.querySelector('input.ask-other');
  assert.strictEqual(input.placeholder, 'Other');
  typeInto(input, 'Dry');
  assert.deepStrictEqual(labels(card), ['1. Formal', '2. Casual & short', 'Send']);
  assert.strictEqual(card.ownerDocument.activeElement, card.querySelector('input.ask-other')); // the focus stays in the field
  click(card.querySelectorAll('button[data-ask="0"]')[0]); // recorded, not sent: something is typed in Other
  assert.strictEqual(T.pendingPreviews.size, 1);
  assert.ok(card.querySelector('button[data-ask="0"]').classList.contains('selected'));
  assert.strictEqual(card.querySelector('input.ask-other').value, 'Dry'); // the Other text kept
  click(card.querySelector('button[data-ask="send"]'));
  let r = await p;
  assert.strictEqual(r.content, 'The user answered:\n1. Which <tone>? \u2014 Formal');
  ({ p, card } = await startAsk(ONE));
  typeInto(card.querySelector('input.ask-other'), '  Dry and short ');
  const ev = key(card.querySelector('input.ask-other'), 'Enter');
  assert.ok(ev.defaultPrevented);
  r = await p;
  assert.strictEqual(r.content, 'The user answered:\n1. Which <tone>? \u2014 Dry and short');
  assert.strictEqual(card.querySelector('summary').textContent, 'ask_user · Chosen: Dry and short · Which <tone>?');
});

test('three questions: one at a time, the numbers, back to question 1 to change it, return to 3, Send sends all three', async () => {
  el.chat.textContent = '';
  const { p, card } = await startAsk(THREE);
  assert.strictEqual(card.querySelector('.pv-head').textContent, 'ask_user · Questions');
  assert.strictEqual(steps(card), '1* 2- 3-'); // the later numbers cannot be reached yet
  assert.strictEqual(card.querySelector('.pv-note').textContent, 'Which spin labels?');
  assert.deepStrictEqual(labels(card).slice(3), ['1. MTSL', '2. TEMPO']); // no Send before the last question
  click(card.querySelector('button[data-ask="1"]')); // TEMPO: recorded, question 2 opens
  assert.strictEqual(T.pendingPreviews.size, 1);
  assert.strictEqual(card.querySelector('.pv-note').textContent, 'Which force field?');
  assert.strictEqual(steps(card), '1+ 2* 3-');
  assert.strictEqual(card.ownerDocument.activeElement, card.querySelector('button[data-ask="0"]')); // the keyboard goes on
  click(card.querySelector('button[data-ask="2"]')); // OPLS
  assert.strictEqual(card.querySelector('.pv-note').textContent, 'How do you validate them?');
  assert.strictEqual(card.querySelectorAll('.ask-options').length, 0); // no suggested answers: the Other field only
  assert.strictEqual(card.querySelector('button[data-ask="send"]').disabled, true); // the last question: Send, not yet
  assert.strictEqual(card.ownerDocument.activeElement, card.querySelector('input.ask-other'));
  typeInto(card.querySelector('input.ask-other'), 'DEER distances');
  assert.strictEqual(card.querySelector('button[data-ask="send"]').disabled, false);
  key(card.querySelector('input.ask-other'), 'Enter'); // the last question: recorded, nothing sent
  assert.strictEqual(T.pendingPreviews.size, 1);
  assert.strictEqual(steps(card), '1+ 2+ 3*+');
  // back to question 1: its choice is shown; the arrows move between the numbers
  click(card.querySelector('.ask-step[data-ask-step="0"]'));
  assert.strictEqual(card.querySelector('.pv-note').textContent, 'Which spin labels?');
  assert.ok(card.querySelector('button[data-ask="1"]').classList.contains('selected'));
  assert.strictEqual(card.querySelector('button[data-ask="1"]').getAttribute('aria-pressed'), 'true');
  assert.ok(card.querySelector('button[data-ask="send"]')); // every question answered: Send on any question
  const one = card.querySelector('.ask-step[data-ask-step="0"]');
  one.focus();
  key(one, 'ArrowRight');
  assert.strictEqual(card.ownerDocument.activeElement, card.querySelector('.ask-step[data-ask-step="1"]'));
  click(card.querySelector('button[data-ask="0"]')); // MTSL instead of TEMPO: all answered, back to the last question
  assert.strictEqual(card.querySelector('.pv-note').textContent, 'How do you validate them?');
  assert.strictEqual(card.querySelector('input.ask-other').value, 'DEER distances');
  assert.ok(card.querySelector('input.ask-other').classList.contains('chosen'));
  click(card.querySelector('button[data-ask="send"]'));
  const r = await p;
  assert.strictEqual(r.content, 'The user answered:\n1. Which spin labels? \u2014 MTSL\n2. Which force field? \u2014 OPLS\n3. How do you validate them? \u2014 DEER distances');
  assert.strictEqual(r._message, 'Answered 3 questions');
  assert.strictEqual(card.querySelector('summary').textContent, 'ask_user · Answered 3 questions · Which spin labels?');
  assert.deepStrictEqual([...card.querySelectorAll('.log-asked')].map((x) => x.textContent),
    ['1. Which spin labels? \u2014 MTSL', '2. Which force field? \u2014 OPLS', '3. How do you validate them? \u2014 DEER distances']);
  assert.strictEqual(card.querySelectorAll('button, input').length, 0);
});

const MULTI = { questions: [{ question: 'Which sections?', options: ['Intro', 'Methods', 'Results'], multiple: true }] };
test('a multiple question: the answers toggle, Apply is off until a pick, Apply sends the picks joined (Other last); Stop', async () => {
  el.chat.textContent = '';
  let { p, card } = await startAsk(MULTI);
  assert.deepStrictEqual(labels(card), ['1. Intro', '2. Methods', '3. Results', 'Apply']);
  assert.strictEqual(card.querySelector('button[data-ask="send"]'), null); // Apply in its place
  assert.strictEqual(card.querySelector('button[data-ask="apply"]').disabled, true);
  assert.ok(!card.querySelector('button[data-ask="0"]').classList.contains('primary')); // nothing looks picked before a pick
  click(card.querySelector('button[data-ask="2"]'));
  click(card.querySelector('button[data-ask="0"]'));
  click(card.querySelector('button[data-ask="1"]'));
  click(card.querySelector('button[data-ask="1"]')); // unpicked again
  assert.strictEqual(T.pendingPreviews.size, 1); // a click does not send
  const on = (c) => [...c.querySelectorAll('.ask-options button')].map((b) => b.classList.contains('selected') && b.classList.contains('primary') && b.getAttribute('aria-pressed') === 'true');
  assert.deepStrictEqual(on(card), [true, false, true]);
  assert.strictEqual(card.ownerDocument.activeElement, card.querySelector('button[data-ask="1"]')); // the toggled answer keeps the focus
  assert.strictEqual(card.querySelector('button[data-ask="apply"]').disabled, false);
  click(card.querySelector('button[data-ask="apply"]'));
  let r = await p;
  assert.strictEqual(r.content, 'The user answered:\n1. Which sections? \u2014 Intro; Results'); // in the order of the list
  assert.strictEqual(card.querySelector('summary').textContent, 'ask_user · Chosen: Intro; Results · Which sections?');
  // with Other: appended last; Other alone enables Apply; Enter in Other applies
  ({ p, card } = await startAsk(MULTI));
  typeInto(card.querySelector('input.ask-other'), 'the abstract');
  assert.strictEqual(card.querySelector('button[data-ask="apply"]').disabled, false);
  assert.ok(card.querySelector('input.ask-other').classList.contains('chosen'));
  click(card.querySelector('button[data-ask="2"]'));
  click(card.querySelector('button[data-ask="0"]'));
  assert.strictEqual(card.querySelector('input.ask-other').value, 'the abstract');
  key(card.querySelector('input.ask-other'), 'Enter');
  r = await p;
  assert.strictEqual(r.content, 'The user answered:\n1. Which sections? \u2014 Intro; Results; the abstract');
  // unpicking the last answer disables Apply again; Enter with nothing does nothing; Stop ends it
  let ac;
  ({ p, card, ac } = await startAsk(MULTI));
  click(card.querySelector('button[data-ask="0"]'));
  click(card.querySelector('button[data-ask="0"]'));
  assert.strictEqual(card.querySelector('button[data-ask="apply"]').disabled, true);
  key(card.querySelector('input.ask-other'), 'Enter');
  assert.strictEqual(T.pendingPreviews.size, 1);
  ac.abort();
  r = await p;
  assert.deepStrictEqual([r.content, r._decision], [T.ASK_STOPPED_TEXT, 'stopped']);
});

test('two questions, a multiple then a single: Apply moves on, the single click does not send, Send sends both; Apply on the last question sends', async () => {
  el.chat.textContent = '';
  const TWO = { questions: [{ question: 'Which sections?', options: ['Intro', 'Methods', 'Results'], multiple: true }, { question: 'How short?', options: ['Half', 'A third'] }] };
  let { p, card } = await startAsk(TWO);
  click(card.querySelector('button[data-ask="0"]'));
  click(card.querySelector('button[data-ask="2"]'));
  assert.strictEqual(steps(card), '1*+ 2'); // the pick answers question 1, question 2 reachable
  click(card.querySelector('button[data-ask="apply"]'));
  assert.strictEqual(card.querySelector('.pv-note').textContent, 'How short?');
  assert.strictEqual(card.querySelector('button[data-ask="apply"]'), null); // a single question: no Apply
  click(card.querySelector('button[data-ask="1"]')); // recorded; several questions: Send decides
  assert.strictEqual(T.pendingPreviews.size, 1);
  click(card.querySelector('button[data-ask="send"]'));
  let r = await p;
  assert.strictEqual(r.content, 'The user answered:\n1. Which sections? \u2014 Intro; Results\n2. How short? \u2014 A third');
  assert.deepStrictEqual([...card.querySelectorAll('.log-asked')].map((x) => x.textContent), ['1. Which sections? \u2014 Intro; Results', '2. How short? \u2014 A third']);
  // the other order: the last question is the multiple one, its Apply sends the card
  const REV = { questions: [TWO.questions[1], TWO.questions[0]] };
  ({ p, card } = await startAsk(REV));
  click(card.querySelector('button[data-ask="0"]')); // Half, question 2 opens
  click(card.querySelector('button[data-ask="1"]'));
  typeInto(card.querySelector('input.ask-other'), 'Discussion');
  click(card.querySelector('button[data-ask="apply"]'));
  r = await p;
  assert.strictEqual(r.content, 'The user answered:\n1. How short? \u2014 Half\n2. Which sections? \u2014 Methods; Discussion');
  assert.strictEqual($$('[data-ask="chat"]').length, 0);
});

test('Stop on a questionnaire ends it without answers', async () => {
  el.chat.textContent = '';
  const { p, card, ac } = await startAsk(THREE);
  click(card.querySelector('button[data-ask="0"]'));
  ac.abort();
  const r = await p;
  assert.deepStrictEqual([r.content, r._decision], [T.ASK_STOPPED_TEXT, 'stopped']);
  assert.strictEqual(card.querySelector('summary').textContent, 'ask_user · Stopped · Which spin labels?');
});

test('Other text is the answer of the current question: typing after a pick switches to it, a click switches back; Send takes it without Enter', async () => {
  el.chat.textContent = '';
  const { p, card } = await startAsk(THREE);
  click(card.querySelector('button[data-ask="1"]')); // TEMPO, question 2 opens
  click(card.querySelector('.ask-step[data-ask-step="0"]')); // back to question 1
  assert.ok(card.querySelector('button[data-ask="1"]').classList.contains('selected'));
  const input = card.querySelector('input.ask-other');
  assert.strictEqual(input.getAttribute('data-tip'), null); // the placeholder says it: no tooltip to fire again on a redraw
  typeInto(input, 'Nitroxide X');
  assert.ok(!card.querySelector('button[data-ask="1"]').classList.contains('selected'), 'the option is no longer picked');
  assert.ok(card.querySelector('input.ask-other').classList.contains('chosen'));
  assert.strictEqual(card.ownerDocument.activeElement, card.querySelector('input.ask-other')); // the focus stays
  click(card.querySelector('button[data-ask="0"]')); // MTSL: the option again, question 2 opens
  click(card.querySelector('.ask-step[data-ask-step="0"]'));
  assert.ok(card.querySelector('button[data-ask="0"]').classList.contains('selected'));
  assert.strictEqual(card.querySelector('input.ask-other').value, 'Nitroxide X'); // the text kept
  typeInto(card.querySelector('input.ask-other'), 'Nitroxide Y'); // typed again: the answer
  click(card.querySelector('.ask-step[data-ask-step="1"]'));
  click(card.querySelector('button[data-ask="1"]')); // CHARMM
  typeInto(card.querySelector('input.ask-other'), 'DEER'); // question 3, no Enter
  click(card.querySelector('button[data-ask="send"]'));
  const r = await p;
  assert.strictEqual(r.content, 'The user answered:\n1. Which spin labels? \u2014 Nitroxide Y\n2. Which force field? \u2014 CHARMM\n3. How do you validate them? \u2014 DEER');
});

test('an IME composition: the first character does not redraw the card; compositionend does', async () => {
  el.chat.textContent = '';
  const { p, card } = await startAsk(ONE);
  const input = card.querySelector('input.ask-other');
  const W = card.ownerDocument.defaultView;
  input.focus();
  input.value = 'に';
  input.dispatchEvent(new W.InputEvent('input', { bubbles: true, isComposing: true }));
  assert.strictEqual(card.querySelector('input.ask-other'), input, 'the same input element: not redrawn');
  assert.strictEqual(card.querySelector('button[data-ask="send"]'), null);
  input.value = '日本';
  input.dispatchEvent(new W.CompositionEvent('compositionend', { bubbles: true, data: '日本' }));
  assert.notStrictEqual(card.querySelector('input.ask-other'), input, 'redrawn once the composition ended');
  assert.ok(card.querySelector('button[data-ask="send"]'));
  assert.strictEqual(card.querySelector('input.ask-other').value, '日本');
  click(card.querySelector('button[data-ask="send"]'));
  assert.strictEqual((await p).content, 'The user answered:\n1. Which <tone>? \u2014 日本');
});

test('renderHistory: an _auto continuation is a row of the turn\'s bubble, not a user bubble or a notice; drawn once by renderHistoryKeepingUnstored', () => {
  T.state.messages = [
    { role: 'user', content: 'Write a long list' },
    { role: 'assistant', content: 'Item 1, item 2, it' },
    { role: 'user', content: T.AUTO_CONTINUE_TEXT, _auto: true },
    { role: 'assistant', content: 'em 3.' },
  ];
  T.renderHistory();
  assert.strictEqual($$('.msg.user').length, 1);
  assert.strictEqual($$('.msg.assistant').length, 1);
  const rows = $$('.msg.assistant .activity-rows > .note-stage > .note-row');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].textContent, 'Reply cut by the length limit: asked the model to continue');
  assert.strictEqual(rows[0].dataset.tip, 'Sent by the panel');
  // a row in the row type on the rail (no frame of its own: not a .msg), nothing to open
  assert.ok(rows[0].classList.contains('activity-row') && rows[0].tagName === 'DIV');
  assert.ok(rows[0].parentNode.classList.contains('tl-item'));
  assert.strictEqual($$('.notice').length, 0);
  assert.ok(!el.chat.textContent.includes('Continue exactly where it stopped'));
  T.renderHistoryKeepingUnstored();
  assert.strictEqual($$('.msg.assistant .note-row').length, 1);
  T.state.messages = [];
  T.renderHistory();
});
