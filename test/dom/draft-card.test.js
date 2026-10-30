'use strict';
// The draft plan checklist card on a real DOM: it comes back on its own after a re-render of the idle chat and on a
// chat switch (the chat observer), only in the chat that has the plan, and End draft clears the plan by click.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { load, click, tick } = require('../lib/dom-sandbox');
const { installDocTab } = require('../lib/sandbox');

let env, T, state, el, storage;
const DOC = `# Paper\n\n## Introduction\n\n${Array.from({ length: 45 }, (_, i) => 'w' + i).join(' ')}.\n\n## Methods\n\nShort.`;
const cards = () => [...el.chat.querySelectorAll('.draft-card')];
const until = async (cond, what) => { for (let i = 0; i < 200; i++) { if (cond()) return; await tick(5); } throw new Error('timed out waiting for ' + what); };

before(async () => {
  env = await load();
  ({ T, state, el, storage } = env);
  installDocTab(env);
  env.chrome.tabs.sendMessage = async (id, msg) => (msg.type === 'GET_DOC_TEXT' ? { ok: true, text: DOC, format: 'markdown', title: 'My Doc' }
    : msg.type === 'GET_SELECTION' ? { ok: true, text: '' } : { ok: true, title: 'My Doc' });
  await T.refreshContext({ force: true });
  Object.assign(state, { docText: DOC, docFormat: 'markdown', docModel: null }); // the export as a turn would read it
});
after(() => env.close());

test('re-render and chat switch bring the card back; only the chat with the plan has it; End draft by click', async () => {
  const chatA = state.chatId;
  state.messages.push({ role: 'user', content: 'Plan a paper' }, { role: 'assistant', content: 'Planned.' }); // a chat with history
  T.renderHistory();
  storage[`muninDraft:DOC123:${chatA}`] = { sections: [{ heading: 'Introduction', intent: 'why', done: false }, { heading: 'Methods', intent: 'how', done: false }], readers: [], updatedAt: 1 };
  await T.refreshDraftCard();
  assert.strictEqual(cards().length, 1);
  assert.match(cards()[0].textContent, /Draft plan: 1 of 2 sections written/);
  assert.deepStrictEqual([...cards()[0].querySelectorAll('li')].map((li) => [li.textContent, li.className]), [['☑ Introduction', 'done'], ['☐ Methods', '']]);
  // a re-render of the idle chat drops it; the observer draws it again
  T.renderHistory();
  await until(() => cards().length === 1, 'the card after a re-render');
  // another chat: no card; back: the card
  await T.createChat();
  await until(() => cards().length === 0, 'no card in the new chat');
  await T.switchChat(chatA);
  await until(() => cards().length === 1, 'the card after switching back');
  // End draft
  click(cards()[0].querySelector('button[data-draft="end"]'));
  await until(() => cards().length === 0, 'the card gone');
  assert.strictEqual(storage[`muninDraft:DOC123:${chatA}`], undefined);
  assert.ok([...el.chat.querySelectorAll('.msg.notice')].some((n) => n.textContent === 'Draft ended: the plan of this chat is cleared.'));
});
