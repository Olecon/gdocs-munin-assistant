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
    msgStart + think + tu(1, 'toolu_s1', 'read_document', { scope: { start: 1, end: 62 }, include: ['text'], doc: null }) + stopTool,
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
  assert.strictEqual(h[2].content, '[read_document lines 1–62: content omitted after the turn; re-read if needed]');
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
    '<pre>[read_document lines 1–62: content omitted after the turn; re-read if needed]</pre>'));
  deq(T.logEntry(h[1].tool_calls[0], h[2]).omitted, full.length);
  // the next turn sends the stubs (and the model is told it may re-read)
  const next = recordFetch(env, [textRound('OK.')]);
  await send(env, 'and now?');
  const sent = next[0].messages.flatMap((m) => m.content).filter((c) => c.type === 'tool_result').map((c) => c.content);
  deq(sent, ['[read_document lines 1–62: content omitted after the turn; re-read if needed]', '[find_in_document "words": content omitted after the turn; re-read if needed]']);
  assert.ok(!next[0].system[0].text.includes('content omitted')); // the stub itself says "re-read if needed"
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
  assert.strictEqual(msgs[4].content, 'Opened as doc2. Title: "Ref". 120 lines, 9,000 characters.\n[The rest of this result was omitted after the turn; read_document with this alias reads it again if needed.]');
  assert.strictEqual(msgs[5].content, 'The document has no headings (5 lines).'); // short: kept
  assert.strictEqual(msgs[6].content, 'F'.repeat(300)); // compacted: never sent, kept as compaction left it
  assert.strictEqual(msgs[0]._context, '<document title="D">\nOutline\n</document>'); // user messages untouched
  const once = JSON.stringify(msgs);
  assert.strictEqual(T.slimHistory(msgs), 0); // idempotent
  assert.strictEqual(JSON.stringify(msgs), once);
});

test('lookup digests: kept in the history (_digest); Munin gets only the newest five of the older turns, older ones as the plain stub; OpenAI gets all; old stubs stay as they were', async () => {
  const PAPERS = Array.from({ length: 6 }, (_, i) => ({ doi: `10.1/p${i}`, title: `Paper ${i} on spin labels`, authors: ['A. B'], year: 2020 + i, journal: 'J', abstract: 'a'.repeat(300) }));
  const turn = (k) => [
    { role: 'user', content: `question ${k}` },
    { role: 'assistant', content: null, tool_calls: [call(`s${k}`, 'search', { query: `topic ${k}`, where: 'database', top_k: null })] },
    { role: 'tool', tool_call_id: `s${k}`, content: T.formatPapers(`topic ${k}`, PAPERS).text, _ok: true, _reading: true },
    { role: 'assistant', content: `Answer ${k}.` },
  ];
  // a chat stored before digests: its stub stays as it is
  const old = [{ role: 'user', content: 'old' }, { role: 'assistant', content: null, tool_calls: [call('s0', 'search', { query: 'old', where: 'web', top_k: null })] },
    { role: 'tool', tool_call_id: 's0', content: '[search: content omitted after the turn; re-read if needed]', _ok: true, _reading: true, _omittedChars: 2000 },
    { role: 'assistant', content: 'Old answer.' }];
  const msgs = [...old, ...[1, 2, 3, 4, 5, 6, 7].flatMap(turn)];
  assert.strictEqual(T.slimHistory(msgs), 7);
  const tools = () => msgs.filter((m) => m.role === 'tool');
  assert.strictEqual(tools()[0].content, '[search: content omitted after the turn; re-read if needed]');
  assert.ok(tools()[0]._digest === undefined && tools().slice(1).every((m) => m._digest && m.content.startsWith('[search database «topic ')), JSON.stringify(tools()[1]));
  assert.ok(tools()[1].content.endsWith('\n1 more and the abstracts omitted after the turn]'), tools()[1].content);
  const stored = JSON.stringify(msgs);
  // Munin (no prompt cache): the newest five digests of the older turns, the two before them as the plain stub
  useProvider(env, 'munin');
  await T.createChat();
  state.messages.push(...msgs);
  await T.saveHistory();
  const bodies = recordFetch(env, [`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'OK.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`]);
  await send(env, 'and now?');
  const sent = bodies[0].messages.filter((m) => m.role === 'tool').map((m) => m.content);
  deq(sent.slice(0, 3), ['[search: content omitted after the turn; re-read if needed]', '[search: content omitted after the turn; re-read if needed]', '[search: content omitted after the turn; re-read if needed]']);
  assert.ok(sent.slice(3).every((c) => c.startsWith('[search database «topic ')) && sent.length === 8, JSON.stringify(sent));
  assert.strictEqual(sent[3], msgs[14].content); // topic 3: the oldest digest still sent
  // the budget's per-message sizes (fitMessages) count the same request as is built: the stubs, not the digests
  const hist = T.activeHistory(state.messages);
  const built = T.buildApiMessages(true, hist, '', { shortOld: true }).slice(1);
  assert.strictEqual(T.sentSizes(true, hist, { shortOld: true }).reduce((a, b) => a + b, 0), built.reduce((n, m) => n + T.messageChars(m), 0));
  assert.ok(T.sentSizes(true, hist, { shortOld: true }).reduce((a, b) => a + b, 0) < T.sentSizes(true, hist, { shortOld: false }).reduce((a, b) => a + b, 0));
  assert.strictEqual(JSON.stringify(state.messages.slice(0, msgs.length)), stored); // the stored history keeps every digest
  // OpenAI (a prompt cache: older turns are sent as they were): every digest
  useProvider(env, 'openai', { model: 'gpt-6.1-sol' });
  await T.createChat();
  state.messages.push(...JSON.parse(stored));
  await T.saveHistory();
  const oa = recordFetch(env, [require('./lib/context').oaText('OK.')]);
  await send(env, 'and now?');
  const outs = oa[0].input.filter((i) => i.type === 'function_call_output').map((i) => i.output);
  assert.strictEqual(outs.filter((o) => o.startsWith('[search database «topic ')).length, 7);
});

test('a registered digest (registry.js): used when shorter than the result; one that throws, is empty or is longer gives the plain stub', () => {
  let digest = () => { throw new Error('boom'); };
  T.registerTools({ type: 'function', function: { name: 'probe_lookup', description: 'x', parameters: { type: 'object', properties: {} } } },
    { offer: () => false, run: () => '', reading: true, digest: (name, args, content, why) => digest(name, args, content, why) });
  const fn = { name: 'probe_lookup', arguments: '{"q":"x"}' };
  const plain = '[probe_lookup: content omitted after the turn; re-read if needed]';
  const warn = console.warn;
  console.warn = () => {};
  assert.strictEqual(T.readingStub(fn, 'x'.repeat(300), 'after the turn'), plain);
  console.warn = warn;
  digest = () => '';
  assert.strictEqual(T.readingStub(fn, 'x'.repeat(300), 'after the turn'), plain);
  digest = (name, args, content, why) => `[probe_lookup ${args.q}: ${content.length} characters, ${why}]`;
  assert.strictEqual(T.readingStub(fn, 'x'.repeat(300), 'to fit the context window'), '[probe_lookup x: 300 characters, to fit the context window]');
  assert.strictEqual(T.readingStub(fn, 'x'.repeat(300), 'after the turn', { plain: true }), plain);
  digest = () => 'd'.repeat(400);
  assert.strictEqual(T.readingStub(fn, 'x'.repeat(300), 'after the turn'), plain);
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
