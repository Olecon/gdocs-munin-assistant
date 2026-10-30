'use strict';
// History slimming after a turn and on chat load: reading results become stubs, replay payloads are dropped,
// edits and their journals stay; the action log shows the stub with the original size.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load } = require('./lib/sandbox');
const { ev, tu, msgStart, stopTool, textRound } = require('./lib/streams');
const { docBench, recordFetch, useProvider, send } = require('./lib/context');

let env, T, state, doc;
const BIG = ['# Big', '', ...Array.from({ length: 60 }, (_, i) => `Line ${i + 3} with some words in it.`)].join('\n');
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

before(async () => {
  env = await load();
  T = env.T;
  state = env.state;
  ({ doc } = docBench(env));
  await T.refreshContext({ force: true });
});

test('after a turn: reading results stubbed with their size, replay payloads dropped, the action log shows the stub', async () => {
  useProvider(env, 'anthropic', { model: 'claude-opus-5-5' });
  await T.createChat();
  T.el.chat.children.length = 0;
  doc.text = BIG; doc.selection = '';
  const think = ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }) +
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Read first.' } }) +
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'S' } }) +
    ev('content_block_stop', { type: 'content_block_stop', index: 0 });
  const bodies = recordFetch(env, [
    msgStart + think + tu(1, 'toolu_s1', 'read_lines', { start: 1, end: 62, doc: null }) + stopTool,
    msgStart + tu(0, 'toolu_s2', 'find_in_document', { query: 'words', doc: null }) + stopTool,
    textRound('Read.'),
  ]);
  await send(env, 'read everything');
  assert.strictEqual(bodies.length, 3);
  // during the turn the model got the full results and the thinking replay
  const full = bodies[1].messages[2].content[0].content;
  assert.ok(full.startsWith('Lines 1-62 of 62:\n1: # Big') && full.length > 1500);
  assert.strictEqual(bodies[1].messages[1].content[0].type, 'thinking');
  // after the turn
  const h = state.messages;
  deq(h.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant']);
  assert.strictEqual(h[2].content, '[read_lines 1–62: content omitted after the turn; re-read if needed]');
  assert.strictEqual(h[2]._omittedChars, full.length);
  assert.strictEqual(h[4].content, '[find_in_document "words": content omitted after the turn; re-read if needed]');
  assert.ok(h[4]._omittedChars > 200);
  assert.ok(h.every((m) => m._anthropicBlocks === undefined && m._openaiItems === undefined));
  assert.strictEqual(h[1]._reasoning, 'Read first.'); // display fields stay
  assert.ok(h[2]._reading && h[2]._ok);
  // persisted
  deq(env.storage['muninChatHistory:DOC123:' + state.chatId][2].content, h[2].content);
  // the action log (re-rendered from the history): the stub and the original size
  T.el.chat.children.length = 0;
  T.renderHistory();
  const rows = T.el.chat.children.filter((c) => c._rows && c._rows.length).flatMap((b) => b._rows);
  assert.strictEqual(rows.length, 2);
  assert.ok(rows[0].innerHTML.includes(`<div class="log-label">Result (omitted, was ${full.length.toLocaleString('en-US')} characters)</div>` +
    '<pre>[read_lines 1–62: content omitted after the turn; re-read if needed]</pre>'));
  deq(T.logEntry(h[1].tool_calls[0], h[2]).omitted, full.length);
  // the next turn sends the stubs (and the model is told it may re-read)
  const next = recordFetch(env, [textRound('OK.')]);
  await send(env, 'and now?');
  const sent = next[0].messages.flatMap((m) => m.content).filter((c) => c.type === 'tool_result').map((c) => c.content);
  deq(sent, ['[read_lines 1–62: content omitted after the turn; re-read if needed]', '[find_in_document "words": content omitted after the turn; re-read if needed]']);
  assert.ok(next[0].system[0].text.includes('Results of reading tools from earlier messages are replaced by a short note'));
});

test('slimHistory: edits and journals untouched, short and compacted results kept, open_document keeps its first line, idempotent', () => {
  const editResult = 'Done: replaced line 4.\nLines 4-4 now:\n4: ' + 'x'.repeat(400) + '\nThe document now has 10 lines.';
  const opened = 'Opened as doc2. Title: "Ref". 120 lines, 9,000 characters.\nOutline (line: heading):\n' + Array.from({ length: 30 }, (_, i) => `L${i + 1}: # H${i}`).join('\n');
  const msgs = [
    { role: 'user', content: 'go', _context: '<document title="D">\nOutline\n</document>' },
    { role: 'assistant', content: null, tool_calls: [call('a', 'read_lines', { start: 3, end: 9, doc: 'doc2' }), call('b', 'replace_text', { old_text: 'a', new_text: 'b' }), call('c', 'open_document', { url: 'x' }), call('d', 'get_outline', { doc: null }), call('e', 'read_formatting', { start: 1, end: 2 })],
      _anthropicBlocks: [{ type: 'thinking', thinking: 't', signature: 's' }], _openaiItems: [{ type: 'reasoning' }] },
    { role: 'tool', tool_call_id: 'a', content: 'L'.repeat(500), _ok: true, _reading: true },
    { role: 'tool', tool_call_id: 'b', content: editResult, _ok: true, _edit: { id: 'b', ops: [{ kind: 'replace' }] } },
    { role: 'tool', tool_call_id: 'c', content: opened, _ok: true, _reading: true },
    { role: 'tool', tool_call_id: 'd', content: 'The document has no headings (5 lines).', _ok: true, _reading: true },
    { role: 'tool', tool_call_id: 'e', content: 'F'.repeat(300), _ok: true, _reading: true, _compacted: true },
    { role: 'assistant', content: 'Done.' },
  ];
  assert.strictEqual(T.slimHistory(msgs), 3); // the assistant message (payloads) and two results
  assert.strictEqual(msgs[1]._anthropicBlocks, undefined); assert.strictEqual(msgs[1]._openaiItems, undefined);
  assert.strictEqual(msgs[2].content, '[read_lines 3–9 (doc2): content omitted after the turn; re-read if needed]');
  assert.strictEqual(msgs[2]._omittedChars, 500);
  assert.strictEqual(msgs[3].content, editResult); deq(msgs[3]._edit, { id: 'b', ops: [{ kind: 'replace' }] }); // edits untouched
  assert.strictEqual(msgs[4].content, 'Opened as doc2. Title: "Ref". 120 lines, 9,000 characters.\n[The rest of this result was omitted after the turn; call get_outline with this alias if needed.]');
  assert.strictEqual(msgs[5].content, 'The document has no headings (5 lines).'); // short: kept
  assert.strictEqual(msgs[6].content, 'F'.repeat(300)); // compacted: never sent, kept as compaction left it
  assert.strictEqual(msgs[0]._context, '<document title="D">\nOutline\n</document>'); // user messages untouched
  const once = JSON.stringify(msgs);
  assert.strictEqual(T.slimHistory(msgs), 0); // idempotent
  assert.strictEqual(JSON.stringify(msgs), once);
});

test('chat load: an old chat is slimmed when it is read from storage', async () => {
  useProvider(env, 'anthropic');
  await T.createChat();
  const oldId = state.chatId;
  const fat = [
    { role: 'user', content: 'old question' },
    { role: 'assistant', content: null, tool_calls: [call('o1', 'read_lines', { start: 1, end: 40, doc: null })], _anthropicBlocks: [{ type: 'tool_use', id: 'o1', name: 'read_lines', input: {} }] },
    { role: 'tool', tool_call_id: 'o1', content: 'Lines 1-40 of 40:\n' + 'q'.repeat(3000), _ok: true, _reading: true },
    { role: 'assistant', content: 'Answer.' },
  ];
  state.messages.push({ role: 'user', content: 'x' }); // (an empty chat would be reused by createChat)
  await T.createChat(); // leave the chat, then give it an old, unslimmed history in storage
  env.storage['muninChatHistory:DOC123:' + oldId] = JSON.parse(JSON.stringify(fat));
  await T.switchChat(oldId);
  assert.strictEqual(state.chatId, oldId);
  assert.strictEqual(state.messages[2].content, '[read_lines 1–40: content omitted after the turn; re-read if needed]');
  assert.strictEqual(state.messages[2]._omittedChars, 3018);
  assert.strictEqual(state.messages[1]._anthropicBlocks, undefined);
  // the panel reload path (loadChatStore) slims too
  env.storage['muninChatHistory:DOC123:' + oldId] = JSON.parse(JSON.stringify(fat));
  env.storage['muninCurrentChat:DOC123'] = oldId;
  const store = await T.loadChatStore('DOC123');
  assert.strictEqual(store.chatId, oldId);
  assert.strictEqual(store.messages[2]._omittedChars, 3018);
});
