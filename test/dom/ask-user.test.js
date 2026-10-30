'use strict';
// ask_user on a real DOM (jsdom): the answer buttons of the question card are real buttons that decide it on a
// click (the card's own handler; the chat's click delegation knows only data-act buttons), the decided card
// hides its buttons, and the auto-continue row of a stored history is a notice row, not a user bubble.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { load, click } = require('../lib/dom-sandbox');
const { waitFor } = require('../lib/sandbox');

let env, T, el;
const $$ = (sel) => [...el.chat.querySelectorAll(sel)];

before(async () => {
  env = await load();
  ({ T, el } = env);
});

const askCall = (id) => ({ id, type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ question: 'Which <tone>?', options: ['Formal', 'Casual & short'] }) } });

test('clicking an option decides the card; "I\'ll answer in chat" too', async () => {
  el.chat.textContent = '';
  const s = T.takeSnapshot();
  s.signal = new AbortController().signal;
  let p = T.executeTool(askCall('a1'), 'manual', s, {});
  await waitFor(() => $$('.tool-card.preview.ask').length === 1, 'the question card');
  const card = $$('.tool-card.preview.ask')[0];
  assert.strictEqual(card.querySelector('.pv-note').textContent, 'Which <tone>?'); // escaped, shown as text
  assert.deepStrictEqual([...card.querySelectorAll('button')].map((b) => b.textContent), ['Formal', 'Casual & short', "I'll answer in chat"]);
  click(card.querySelectorAll('button')[1]);
  let r = await p;
  assert.strictEqual(r.content, 'The user chose: Casual & short.');
  assert.strictEqual(r._decision, 'answered');
  assert.ok(card.classList.contains('decided'));
  click(card.querySelectorAll('button')[0]); // a decided card: no effect
  assert.strictEqual(T.pendingPreviews.size, 0);
  const s2 = T.takeSnapshot();
  s2.signal = new AbortController().signal;
  p = T.executeTool(askCall('a2'), 'manual', s2, {});
  await waitFor(() => $$('.tool-card.preview.ask:not(.decided)').length === 1, 'the second card');
  click($$('.tool-card.preview.ask:not(.decided) button[data-ask="chat"]')[0]);
  r = await p;
  assert.strictEqual(r.content, T.ASK_CHAT_TEXT);
  assert.strictEqual(r._decision, 'chat');
});

test('renderHistory: an _auto continuation is a notice row, not a user bubble, and is kept by renderHistoryKeepingNotices once', () => {
  T.state.messages = [
    { role: 'user', content: 'Write a long list' },
    { role: 'assistant', content: 'Item 1, item 2, it' },
    { role: 'user', content: T.AUTO_CONTINUE_TEXT, _auto: true },
    { role: 'assistant', content: 'em 3.' },
  ];
  T.renderHistory();
  assert.strictEqual($$('.msg.user').length, 1);
  const rows = $$('.msg.notice.auto-continue');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].textContent, 'Reply cut by the length limit: asked the model to continue');
  assert.ok(!el.chat.textContent.includes('Continue exactly where it stopped'));
  T.renderHistoryKeepingNotices();
  assert.strictEqual($$('.msg.notice.auto-continue').length, 1);
  T.state.messages = [];
  T.renderHistory();
});
