'use strict';
// The /side bubbles on a real DOM: the Side badge and class on the question and the answer, Copy works on a
// side answer (the #chat delegation), a re-render keeps the side exchange at the end, the next main turn's
// final render drops it, and a new chat starts without it.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { load, click, tick } = require('../lib/dom-sandbox');
const { installDocTab } = require('../lib/sandbox');
const { textRound } = require('../lib/streams');
const { recordFetch, useProvider, send } = require('../lib/context');

let env, T, state, el, chrome;
const $$ = (sel) => [...el.chat.querySelectorAll(sel)];

before(async () => {
  env = await load();
  ({ T, state, el, chrome } = env);
  installDocTab(env);
  chrome.tabs.sendMessage = async (id, msg) => {
    switch (msg.type) {
      case 'PING': return { ok: true, title: 'My Doc' };
      case 'GET_SELECTION': return { ok: true, text: '' };
      case 'GET_DOC_TEXT': return { ok: true, text: '# My Doc\n\nThe quick brown fox.', format: 'markdown', title: 'My Doc' };
      default: return { ok: true };
    }
  };
  await T.refreshContext({ force: true });
  useProvider(env, 'anthropic', { model: 'claude-opus-5-5' });
});
after(() => env.close());

test('side bubbles: badge and tint, Copy, kept by a re-render, dropped by the next main turn and a new chat', async () => {
  await T.createChat();
  recordFetch(env, [textRound('Main answer.')]);
  await send(env, 'main question');
  recordFetch(env, [textRound('A **side** answer.')]);
  await send(env, '/side what is a fox?');
  const side = $$('.msg.side');
  assert.strictEqual(side.length, 2);
  assert.ok(side[0].classList.contains('user') && side[1].classList.contains('assistant'));
  assert.deepStrictEqual(side.map((b) => b.querySelector('.side-badge').textContent), ['Side', 'Side']);
  assert.ok(side[0].textContent.endsWith('what is a fox?'));
  assert.strictEqual(side[1].querySelector('.md strong').textContent, 'side');
  // the side exchange is the end of the chat, after the main one
  assert.strictEqual(el.chat.lastElementChild, side[1]);
  assert.strictEqual($$('.msg.user').length, 2);
  // Copy on the side answer copies its text
  click(side[1].querySelector('button[data-act="copy-msg"]'));
  await tick(5);
  assert.deepStrictEqual(env.clipboard.writes.slice(-1), ['A **side** answer.']);
  // a re-render (an undo, another tab's change) puts it back at the end
  T.renderHistory();
  assert.deepStrictEqual($$('.msg.side'), side);
  assert.strictEqual(el.chat.lastElementChild, side[1]);
  // the next main turn: the side exchange stays visible while it runs, then leaves with the final render
  recordFetch(env, [textRound('Main again.')]);
  await send(env, 'next main question');
  assert.strictEqual($$('.msg.side').length, 0);
  assert.strictEqual($$('.msg.user').length, 2);
  assert.strictEqual(state.sideMessages.length, 2); // the side thread itself stays
  // another side question, then a new chat: nothing of it is left
  recordFetch(env, [textRound('Side again.')]);
  await send(env, '/side and a wolf?');
  assert.strictEqual($$('.msg.side').length, 2);
  await T.createChat();
  assert.strictEqual($$('.msg.side').length, 0);
  assert.deepStrictEqual(state.sideMessages.length, 0);
});
