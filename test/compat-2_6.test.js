'use strict';
// A chat saved by version 2.6 (Review mode with add_comment, edit previews with _decision: 'rejected' and
// _preview, a stopped edit) still loads, renders and gives valid request bodies: every tool call has its
// result right after it (Anthropic tool_use -> tool_result, Responses function_call -> function_call_output).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { load } = require('./lib/dom-sandbox');

let env, T, state, el, storage;

const PREVIEW = { tool: 'replace_text', title: 'Replace on line 4', kind: 'replace', line: 4, before: 'Alpha beta gamma.', after: 'Alpha beta GAMMA.' };
const HISTORY_2_6 = [
  { role: 'user', content: 'Review the introduction', _persona: undefined },
  { role: 'assistant', content: 'I will leave two comments.', _reasoning: 'Plan the review.', _usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    tool_calls: [
      { id: 'toolu_c1', type: 'function', function: { name: 'add_comment', arguments: JSON.stringify({ anchor_text: 'Intro text', comment: 'Too vague.' }) } },
      { id: 'toolu_c2', type: 'function', function: { name: 'add_comment', arguments: JSON.stringify({ anchor_text: 'Methods', comment: 'Add details.' }) } },
    ],
    _anthropicBlocks: [
      { type: 'thinking', thinking: 'Plan the review.', signature: 'OLDSIG' },
      { type: 'text', text: 'I will leave two comments.' },
      { type: 'tool_use', id: 'toolu_c1', name: 'add_comment', input: { anchor_text: 'Intro text', comment: 'Too vague.' } },
    ] },
  { role: 'tool', tool_call_id: 'toolu_c1', content: 'Done: comment added on line 2 (quoted passage: "Intro text").', _ok: true, _message: 'Comment added on line 2',
    _comment: { id: 'AAAA', docId: 'DOC123', anchor: 'Intro text', text: 'Too vague.', line: 2, lineEnd: 2, deleted: false }, _decision: 'accepted' },
  { role: 'tool', tool_call_id: 'toolu_c2', content: 'The user rejected this comment. Do not add it again.', _ok: false, _message: 'Comment on line 3',
    _decision: 'rejected', _preview: { tool: 'add_comment', title: 'Comment on line 3', kind: 'comment', line: 3, quote: 'Methods', comment: 'Add details.' } },
  { role: 'assistant', content: 'Left one comment; you rejected the other.', _usage: { prompt_tokens: 150, completion_tokens: 10, total_tokens: 160 } },
  { role: 'user', content: 'Now capitalize gamma' },
  { role: 'assistant', content: null,
    tool_calls: [{ id: 'toolu_e1', type: 'function', function: { name: 'replace_text', arguments: JSON.stringify({ old_text: 'beta gamma', new_text: 'beta GAMMA' }) } }],
    _openaiItems: [{ type: 'function_call', id: 'fc_1', call_id: 'toolu_e1', name: 'replace_text', arguments: '{}' }] },
  { role: 'tool', tool_call_id: 'toolu_e1', content: 'The user rejected this edit. Do not retry it.', _ok: false, _message: 'Replace on line 4', _decision: 'rejected', _preview: PREVIEW },
  { role: 'assistant', content: 'Understood, I left it unchanged.' },
  { role: 'user', content: 'Try once more, then stop' },
  { role: 'assistant', content: 'Trying.',
    tool_calls: [
      { id: 'toolu_e2', type: 'function', function: { name: 'replace_text', arguments: JSON.stringify({ old_text: 'beta gamma', new_text: 'beta Gamma' }) } },
      { id: 'toolu_e3', type: 'function', function: { name: 'delete_lines', arguments: '{"start":9,"end":9}' } },
    ] },
  { role: 'tool', tool_call_id: 'toolu_e2', content: 'Error: the user stopped the answer before deciding on this edit, so nothing was changed.', _ok: false, _message: 'Replace on line 4', _decision: 'stopped', _preview: PREVIEW },
  { role: 'tool', tool_call_id: 'toolu_e3', content: 'Error: cancelled by the user.', _ok: false, _message: 'Cancelled by the user' },
  { role: 'assistant', content: 'Stopped here.' },
];

before(async () => {
  env = await load({ storage: {
    'muninChats:DOC123': [{ id: 'c26', title: 'Review the introduction', createdAt: 1, updatedAt: 2 }],
    'muninChatHistory:DOC123:c26': HISTORY_2_6,
    'muninCurrentChat:DOC123': 'c26',
  } });
  ({ T, state, el, storage } = env);
  const docTab = { id: 7, url: 'https://docs.google.com/document/d/DOC123/edit', title: 'My Doc - Google Docs' };
  env.chrome.tabs.query = async () => [docTab];
  env.chrome.tabs.get = async () => docTab;
  env.chrome.tabs.sendMessage = async (id, msg) => (msg.type === 'GET_SELECTION' ? { ok: true, text: '' } : { ok: true, title: 'My Doc' });
  await T.refreshContext({ force: true });
});
after(() => env.close());

// Checks that every tool call is answered by the next message and that no result is orphaned.
function assertAnthropicPaired(messages) {
  messages.forEach((m, i) => {
    const uses = m.role === 'assistant' ? m.content.filter((b) => b.type === 'tool_use').map((b) => b.id) : [];
    const next = messages[i + 1];
    const results = next && next.role === 'user' ? next.content.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id) : [];
    for (const id of uses) assert.ok(results.includes(id), `tool_use ${id} has a tool_result in the next message`);
    if (m.role === 'user') {
      const prev = messages[i - 1];
      const prevUses = prev && prev.role === 'assistant' ? prev.content.filter((b) => b.type === 'tool_use').map((b) => b.id) : [];
      for (const b of m.content.filter((x) => x.type === 'tool_result')) assert.ok(prevUses.includes(b.tool_use_id), `tool_result ${b.tool_use_id} follows its tool_use`);
    }
  });
  assert.strictEqual(messages[0].role, 'user');
}
function assertResponsesPaired(items) {
  const calls = items.filter((x) => x.type === 'function_call').map((x) => x.call_id);
  const outputs = items.filter((x) => x.type === 'function_call_output').map((x) => x.call_id);
  for (const id of calls) assert.ok(outputs.includes(id), `function_call ${id} has an output`);
  for (const id of outputs) assert.ok(calls.includes(id), `function_call_output ${id} has its call`);
  assert.strictEqual(new Set(calls).size, calls.length, 'no duplicated calls');
}

test('the 2.6 chat loads and renders without errors', () => {
  assert.strictEqual(state.chatId, 'c26');
  assert.strictEqual(state.messages.length, HISTORY_2_6.length);
  assert.doesNotThrow(() => T.renderHistory());
  const kids = [...el.chat.children];
  assert.deepStrictEqual(kids.filter((k) => k.classList.contains('user')).map((k) => k.textContent), ['Review the introduction', 'Now capitalize gamma', 'Try once more, then stop']);
  assert.strictEqual(kids.filter((k) => k.classList.contains('assistant')).length, 6);
  // the old tools get a card each; none offers Undo (nothing was journaled)
  const cards = kids.filter((k) => k.classList.contains('tool-card'));
  assert.strictEqual(cards.length, 5);
  assert.strictEqual(el.chat.querySelectorAll('button[data-act="undo-edit"]').length, 0);
  assert.strictEqual(el.chat.querySelectorAll('.tool-card.preview').length, 0); // no stale permission cards
  // the action log of the comment round lists both calls
  const rows = [...el.chat.querySelectorAll('.activity-row')].map((r) => r.querySelector('.activity-name').textContent);
  assert.ok(rows.filter((n) => n === 'add_comment').length === 2, rows.join(','));
});

test('request bodies from the 2.6 history: no dangling tool calls (Anthropic, OpenAI, Munin)', () => {
  for (const hasTools of [true, false]) {
    const a = T.toAnthropicMessages(hasTools, state.messages);
    assertAnthropicPaired(JSON.parse(JSON.stringify(a)));
    if (!hasTools) assert.ok(a.every((m) => m.content.every((b) => b.type !== 'tool_use' && b.type !== 'tool_result')));
    const r = T.toResponsesInput(hasTools, state.messages);
    assertResponsesPaired(JSON.parse(JSON.stringify(r)));
    const c = JSON.parse(JSON.stringify(T.buildApiMessages(hasTools, state.messages, 'sys')));
    const ids = c.filter((m) => m.role === 'assistant' && m.tool_calls).flatMap((m) => m.tool_calls.map((t) => t.id));
    const res = c.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
    assert.deepStrictEqual(ids.sort(), res.slice().sort());
  }
  // the stored provider blocks of old turns are not replayed (they are before the last user message)
  const a = JSON.parse(JSON.stringify(T.toAnthropicMessages(true, state.messages)));
  assert.ok(!JSON.stringify(a).includes('OLDSIG'));
  assert.ok(!JSON.stringify(T.toResponsesInput(true, state.messages)).includes('fc_1'));
  // the rejected edits reach the model as tool results with the user's decision
  const results = a.flatMap((m) => m.content.filter((b) => b.type === 'tool_result'));
  assert.ok(results.find((b) => b.tool_use_id === 'toolu_e1').content.startsWith('The user rejected this edit'));
  assert.strictEqual(results.find((b) => b.tool_use_id === 'toolu_e1').is_error, true);
});

test('a new turn after the 2.6 history builds full requests for each provider', () => {
  state.messages.push({ role: 'user', content: 'Continue' });
  for (const prov of ['anthropic', 'openai', 'munin']) {
    state.settings.provider = prov;
    state.settings.providers[prov].apiKey = 'k';
    const snap = T.takeSnapshot(); T.snapshotDocument(snap);
    const req = JSON.parse(JSON.stringify(T.buildRequest('edit', snap)));
    if (prov === 'anthropic') assertAnthropicPaired(req.body.messages);
    else if (prov === 'openai') assertResponsesPaired(req.body.input);
    else {
      const ids = req.body.messages.filter((m) => m.tool_calls).flatMap((m) => m.tool_calls.map((t) => t.id));
      assert.deepStrictEqual(ids.sort(), req.body.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id).sort());
    }
    // add_comment is not offered any more
    const names = (req.body.tools || []).map((t) => t.name || (t.function && t.function.name));
    assert.ok(!names.includes('add_comment'), prov);
  }
  state.messages.pop();
  assert.ok(storage['muninChatHistory:DOC123:c26']);
});
