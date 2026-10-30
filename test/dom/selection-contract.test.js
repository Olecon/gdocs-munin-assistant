'use strict';
// Manual-mode edit blocks on a real DOM: a finished answer with one <replacement> / <insertion> block shows
// a labeled card, the prose around it renders as Markdown, and both the card's and the answer's Apply / Copy
// buttons use exactly the block text (the existing paste path); while streaming, the tags stay visible text;
// malformed or several blocks render as before; the history keeps the raw answer.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { load, click, tick } = require('../lib/dom-sandbox');
const { installDocTab, waitFor } = require('../lib/sandbox');

let env, T, state, el, chrome, tabMsgs;
const $$ = (sel, root) => [...(root || el.chat).querySelectorAll(sel)];

before(async () => {
  env = await load();
  ({ T, state, el, chrome } = env);
  installDocTab(env);
  tabMsgs = [];
  chrome.tabs.sendMessage = async (id, msg) => {
    tabMsgs.push(msg);
    switch (msg.type) {
      case 'PING': return { ok: true, title: 'My Doc' };
      case 'GET_SELECTION': return { ok: true, text: 'quick brown' };
      case 'GET_DOC_TEXT': return { ok: true, text: '# My Doc\n\nThe quick brown fox.', format: 'markdown', title: 'My Doc' };
      default: return { ok: true };
    }
  };
  await T.refreshContext({ force: true });
});
after(() => env.close());

const ANSWER = 'Here is the **shorter** version:\n\n<replacement>\nThe **quick** fox.\nSecond line.\n</replacement>\n\n```\ncode\n```';
const BLOCK = 'The **quick** fox.\nSecond line.';

function show(content) {
  state.messages = [{ role: 'user', content: 'Shorten it' }, { role: 'assistant', content }];
  T.renderHistory();
  return $$('.msg.assistant')[0];
}

test('a finished answer with one block: labeled card, prose as Markdown, the raw text stays in the history', () => {
  const b = show(ANSWER);
  const card = b.querySelector('.code-wrap.edit-block.replacement');
  assert.ok(card);
  assert.strictEqual(card.querySelector('.code-lang').textContent, 'Replacement for the selection');
  assert.strictEqual(card.querySelector('pre').textContent, BLOCK); // verbatim, ** not rendered
  assert.strictEqual(b.querySelector('.md p strong').textContent, 'shorter');
  assert.ok(!b.querySelector('.md').textContent.includes('<replacement>'));
  assert.strictEqual(b._text, ANSWER);
  assert.strictEqual(state.messages[1].content, ANSWER);
  // the code block after it keeps its own index; the block card and the answer's buttons point at the block
  assert.deepStrictEqual([...b._codes], [BLOCK, 'code']);
  assert.deepStrictEqual([...card.querySelectorAll('button')].map((x) => [x.dataset.act, x.dataset.idx]), [['apply-code', '0'], ['copy-code', '0']]);
  assert.deepStrictEqual([...b.querySelectorAll('.msg-actions button')].map((x) => [x.dataset.act, x.dataset.idx]), [['apply-code', '0'], ['copy-code', '0']]);
  const ins = show('<insertion>\nA new sentence.\n</insertion>');
  assert.strictEqual(ins.querySelector('.edit-block.insertion .code-lang').textContent, 'Insertion at the cursor');
});

test('Apply to selection and Copy paste / copy exactly the block (card and answer buttons), via the existing paste path', async () => {
  const b = show(ANSWER);
  tabMsgs.length = 0;
  click(b.querySelector('.edit-block button[data-act="apply-code"]'));
  await waitFor(() => $$('.tool-card').length === 1, 'the result card');
  click(b.querySelector('.msg-actions button[data-act="apply-code"]'));
  await waitFor(() => $$('.tool-card').length === 2, 'the second card');
  const pastes = tabMsgs.filter((m) => m.type === 'REPLACE_SELECTION');
  assert.deepStrictEqual(pastes.map((m) => m.text), [BLOCK, BLOCK]);
  assert.ok(pastes.every((m) => m.expected === undefined)); // the button path: wherever the selection / cursor is
  const writes = env.clipboard.writes.length;
  click(b.querySelector('.msg-actions button[data-act="copy-code"]'));
  click(b.querySelector('.edit-block button[data-act="copy-code"]'));
  await tick(5);
  assert.deepStrictEqual(env.clipboard.writes.slice(writes), [BLOCK, BLOCK]);
});

test('malformed or several blocks: rendered as before (tags as text, the answer buttons use the whole answer)', async () => {
  for (const content of ['<replacement>a</replacement> or <replacement>b</replacement>', 'Fix: <replacement>never closed', '<insertion>x</replacement>']) {
    const b = show(content);
    assert.ok(!b.querySelector('.edit-block'), content);
    assert.strictEqual(b.querySelector('.md').textContent, content);
    assert.deepStrictEqual([...b.querySelectorAll('.msg-actions button')].map((x) => x.dataset.act), ['apply-msg', 'copy-msg']);
  }
  const b = show('<replacement>a</replacement> or <replacement>b</replacement>');
  const writes = env.clipboard.writes.length;
  click(b.querySelector('.msg-actions button[data-act="copy-msg"]'));
  await tick(5);
  assert.deepStrictEqual(env.clipboard.writes.slice(writes), ['<replacement>a</replacement> or <replacement>b</replacement>']);
});

test('streaming: the tags are visible text until the answer is finished, then the block card replaces them', () => {
  const b = T.addAssistantBubble();
  T.updateAssistantBubble(b, { text: 'Fix:\n<replacement>\nThe quick', streaming: true });
  assert.ok(!b.querySelector('.edit-block'));
  assert.ok(b.querySelector('.md').textContent.includes('<replacement>'));
  T.updateAssistantBubble(b, { text: 'Fix:\n<replacement>\nThe quick fox.\n</replacement>', streaming: true });
  assert.ok(!b.querySelector('.edit-block')); // complete, but still streaming
  assert.ok(b._parts.actions.classList.contains('hidden'));
  T.updateAssistantBubble(b, { text: 'Fix:\n<replacement>\nThe quick fox.\n</replacement>' });
  assert.strictEqual(b.querySelector('.edit-block pre').textContent, 'The quick fox.');
  assert.ok(!b.querySelector('.md').textContent.includes('<replacement>'));
  assert.strictEqual(b.querySelector('.msg-actions button').dataset.act, 'apply-code');
  assert.ok(!b._parts.actions.classList.contains('hidden'));
  // the same bubble re-rendered without a block gets the answer buttons back
  T.updateAssistantBubble(b, { text: 'Plain answer.' });
  assert.deepStrictEqual([...b.querySelectorAll('.msg-actions button')].map((x) => x.dataset.act), ['apply-msg', 'copy-msg']);
});
