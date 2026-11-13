'use strict';
// The turn's own rows on a real DOM (jsdom; render.js addTurnRow): no fading notice exists any more. A length cut's
// continuation and a second cut are rows of the turn's one bubble, live and after a re-render; a failed document read
// at the start of the turn is a row above the answer in the same bubble (stored on the turn's message); a stopped turn
// says it in its label; a row is the row type on the rail, no frame, nothing to open; a row with a detail opens.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { load, click, key, typeInto, tick } = require('../lib/dom-sandbox');
const { installDocTab, waitFor } = require('../lib/sandbox');
const { ev, msgStart, sseResponse } = require('../lib/streams');

let env, T, state, el, docReply;
before(async () => {
  env = await load();
  ({ T, state, el } = env);
  installDocTab(env);
  docReply = () => ({ ok: true, text: '# My Doc\n\nAlpha line.', format: 'markdown', title: 'My Doc' });
  env.chrome.tabs.sendMessage = async (id, msg) => {
    switch (msg.type) {
      case 'PING': return { ok: true, title: 'My Doc' };
      case 'GET_SELECTION': return { ok: true, text: '' };
      case 'GET_DOC_TEXT': return docReply();
      default: return { ok: true };
    }
  };
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic';
  Object.assign(state.settings.providers.anthropic, { apiKey: 'sk-ant-test', model: 'claude-opus-5-5' });
});
after(() => env.close());

const $$ = (sel) => [...el.chat.querySelectorAll(sel)];
// An Anthropic reply with text, ended by stop_reason (max_tokens: cut by the length limit).
const reply = (t, stop = 'end_turn') => msgStart + ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
  ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }) +
  ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
  ev('message_delta', { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 9 } }) + ev('message_stop', { type: 'message_stop' });
const rowTexts = () => $$('.msg.assistant .activity-rows > .note-stage > .note-row').map((r) => r.textContent);
const CUT = 'The reply was cut off by the length limit.';

async function turn(text) {
  await T.createChat();
  typeInto(el.input, text);
  key(el.input, 'Enter');
  await waitFor(() => state.busy, 'the turn');
  await waitFor(() => !state.busy, 'the end of the turn');
  await tick(10);
}

test('a continuation and a second cut: rows of the one bubble, live and after renderHistory; no notice anywhere', async () => {
  let live = null;
  let n = 0;
  env.ctx.fetch = async (url) => {
    if (!String(url).includes('api.anthropic.com')) return { ok: false, status: 404, text: async () => '' };
    if (n++ === 1) live = { rows: rowTexts(), bubbles: $$('.msg.assistant').length }; // the continuation request
    return sseResponse(reply(n === 1 ? 'Part one, ' : 'part two', 'max_tokens'));
  };
  await turn('A long list');
  deq(live, { rows: [T.AUTO_CONTINUE_NOTICE], bubbles: 1 });
  const check = () => {
    assert.strictEqual($$('.msg.assistant').length, 1);
    assert.deepStrictEqual(rowTexts(), [T.AUTO_CONTINUE_NOTICE, CUT]);
    assert.strictEqual(el.chat.querySelectorAll('.notice, .fading').length, 0);
    // each row a timeline item of its own: the row type, no frame (not a .msg), nothing to open (a plain div)
    for (const r of $$('.note-row')) {
      assert.ok(r.parentNode.classList.contains('tl-item'));
      assert.strictEqual(r.tagName, 'DIV');
      assert.ok(r.classList.contains('activity-row') && !r.closest('.msg.chat-row'));
    }
  };
  check();
  deq(state.messages.at(-1)._notes, [CUT]);
  T.renderHistory();
  check();
});

test('a failed document read: the row is stored on the turn\'s message and stands above the answer in the same bubble', async () => {
  docReply = () => ({ ok: false, error: 'the tab is busy' });
  let live = null;
  env.ctx.fetch = async (url) => {
    if (!String(url).includes('api.anthropic.com')) return { ok: false, status: 404, text: async () => '' };
    live = { rows: rowTexts().length, bubbles: $$('.msg.assistant').length };
    return sseResponse(reply('Answered anyway.'));
  };
  try {
    await turn('Hello');
  } finally {
    docReply = () => ({ ok: true, text: '# My Doc\n\nAlpha line.', format: 'markdown', title: 'My Doc' });
  }
  deq(live, { rows: 1, bubbles: 1 }); // the row's bubble, before the answer
  const user = state.messages.find((m) => m.content === 'Hello');
  assert.strictEqual(user._notes.length, 1);
  assert.match(user._notes[0], /Answering without the document context\.$/);
  for (const redraw of [false, true]) {
    if (redraw) T.renderHistory();
    const bubbles = $$('.msg.assistant');
    assert.strictEqual(bubbles.length, 1);
    assert.deepStrictEqual(rowTexts(), [user._notes[0]]);
    assert.strictEqual(bubbles[0].querySelector('.msg-answer .md').textContent.trim(), 'Answered anyway.');
  }
});

test('a row with a detail opens to it; a row outside a turn sits in the rail\'s column, unstored', () => {
  state.messages = [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello.', _notes: [{ text: 'Structure check: a; b; and 1 more.', detail: 'a\nb\nc' }] }];
  T.renderHistory();
  const row = $$('.note-row')[0];
  assert.strictEqual(row.tagName, 'DETAILS');
  assert.strictEqual(row.querySelector('summary').textContent, 'Structure check: a; b; and 1 more.');
  click(row.querySelector('summary'));
  assert.ok(row.open);
  assert.strictEqual(row.querySelector('.log-detail').textContent, 'a\nb\nc');
  const free = T.addChatRow('Draft ended: the plan of this chat is cleared.');
  assert.ok(free.classList.contains('chat-row') && !free.classList.contains('assistant'));
  T.renderHistoryKeepingUnstored();
  assert.strictEqual($$('.msg.chat-row').length, 1);
  T.renderHistory();
  assert.strictEqual($$('.msg.chat-row').length, 0);
  state.messages = [];
  T.renderHistory();
});

test('an undone edit with something to know: the note on its row (preview and fold), no other line', () => {
  const tc = { id: 'e1', type: 'function', function: { name: 'replace_text', arguments: JSON.stringify({ old_text: 'a', new_text: 'b' }) } };
  const r = { role: 'tool', tool_call_id: 'e1', content: 'Done.', _ok: true, _message: 'Replaced', _edit: { id: 'e1', title: 'Replaced a', undone: true, undoNote: 'Embedded objects could not be restored.' } };
  const row = T.activityRow(T.logEntry(tc, r));
  assert.strictEqual(row.querySelector('.log-status').textContent, 'Undone');
  assert.strictEqual(row.querySelector('.log-preview').textContent, ' · Embedded objects could not be restored.');
  assert.ok([...row.querySelectorAll('.log-undo')].some((d) => d.textContent === 'Embedded objects could not be restored.'));
});

function deq(a, b) { assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b))); }
