'use strict';
// Prompt caching: a static system prompt, the per-turn context in the user message (_context), Anthropic
// cache breakpoints, the OpenAI prompt_cache_key, identical request prefixes across the rounds of a turn.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load } = require('./lib/sandbox');
const { ev, tu, msgStart, stopTool, textRound } = require('./lib/streams');
const { docBench, recordFetch, useProvider, send, oaTool, oaText, muTool, muText, stripCache, breakpoints } = require('./lib/context');

let env, T, state, doc;
const DOC_A = ['# My Doc', '', 'Intro.', '', '## Methods', '', 'Alpha beta gamma.', '', '## Results', '', 'Delta.'].join('\n');
const DOC_B = ['# My Doc', '', 'Intro.', 'A new line.', 'Another one.', '', '## Methods', '', 'Alpha beta gamma.', '', '## Results', '', 'Delta.', '', '## Discussion'].join('\n');
const EPH = { type: 'ephemeral' };

before(async () => {
  env = await load();
  T = env.T;
  state = env.state;
  ({ doc } = docBench(env));
  await T.refreshContext({ force: true });
});

const freshChat = async () => { await T.createChat(); T.el.chat.children.length = 0; };

test('static system prompt: identical across turns with different selections and outlines (all providers)', async () => {
  for (const prov of ['anthropic', 'openai', 'munin']) {
    useProvider(env, prov);
    await freshChat();
    const bodies = recordFetch(env, [prov === 'anthropic' ? textRound('One.') : prov === 'openai' ? oaText('One.') : muText('One.')]);
    doc.text = DOC_A; doc.selection = 'Alpha beta';
    await send(env, 'first');
    doc.text = DOC_B; doc.selection = 'Delta';
    await send(env, 'second');
    assert.strictEqual(bodies.length, 2, prov);
    const sys = (b) => (prov === 'anthropic' ? b.system : prov === 'openai' ? b.instructions : b.messages[0]);
    deq(sys(bodies[1]), sys(bodies[0]), `${prov}: system identical`);
    deq(bodies[1].tools, bodies[0].tools, `${prov}: tools identical`);
    const sysText = JSON.stringify(sys(bodies[0]));
    assert.ok(!sysText.includes('Outline (line: heading)') && !sysText.includes('Alpha beta') && !sysText.includes('Selection: line'), `${prov}: no dynamic part in the system prompt`);
  }
});

test('_context: stored on the user message at send time, rendered before the text, never changed later', async () => {
  useProvider(env, 'anthropic', { model: 'claude-opus-5-5' });
  await freshChat();
  T.ownBaselines.clear(); // the earlier tests' last text would give an own-changes line (own-changes.js)
  const bodies = recordFetch(env, [textRound('One.')]);
  doc.text = DOC_A; doc.selection = 'Alpha beta';
  await send(env, 'first');
  const CTX_A = '<document title="My Doc" format="markdown" lines="11" characters="' + DOC_A.length + '">\nOutline (line: heading):\nL1: # My Doc\nL5: ## Methods\nL9: ## Results\n</document>\n' +
    'Selection: line 7 (10 characters)';
  assert.strictEqual(state.messages[0]._context, CTX_A);
  assert.strictEqual(state.messages[0].content, 'first'); // the user's own text is stored separately
  deq(bodies[0].messages, [{ role: 'user', content: [{ type: 'text', text: `${CTX_A}\n\nfirst`, cache_control: EPH }] }]);
  // the next turn: its own context (new outline, new selection, a changes note); the first turn's message is unchanged
  doc.text = DOC_B; doc.selection = 'Delta';
  await send(env, 'second');
  assert.strictEqual(state.messages[0]._context, CTX_A);
  const ctxB = state.messages[2]._context;
  assert.ok(ctxB.startsWith(`<document title="My Doc" format="markdown" lines="15" characters="${DOC_B.length}">\nOutline (line: heading):\nL1: # My Doc\nL7: ## Methods\nL11: ## Results\nL15: ## Discussion\n</document>\n<document_changes>`));
  assert.ok(ctxB.endsWith('\nSelection: line 13 (5 characters)'));
  deq(stripCache(bodies[1].messages), [
    { role: 'user', content: [{ type: 'text', text: `${CTX_A}\n\nfirst` }] },
    { role: 'assistant', content: [{ type: 'text', text: 'One.' }] },
    { role: 'user', content: [{ type: 'text', text: `${ctxB}\n\nsecond` }] },
  ]);
  // persisted with the history
  assert.strictEqual(env.storage['muninChatHistory:DOC123:' + state.chatId][2]._context, ctxB);
  // OpenAI and Munin render it the same way
  useProvider(env, 'openai');
  const os = T.takeSnapshot(); T.snapshotDocument(os);
  assert.strictEqual(T.fitMessages('edit', os).messages[3].content, `${ctxB}\n\nsecond`); // the Chat Completions shape
  deq(T.toResponsesInput(true, state.messages)[0], { role: 'user', content: `${CTX_A}\n\nfirst` });
});

test('Anthropic: cache breakpoints on the system prompt, the previous turn\'s user message and the last block', async () => {
  useProvider(env, 'anthropic', { model: 'claude-opus-5-5' });
  await freshChat();
  doc.text = DOC_A; doc.selection = '';
  let bodies = recordFetch(env, [textRound('One.')]);
  await send(env, 'first');
  deq(breakpoints(bodies[0]), ['system:0', 'messages:0:0']); // first turn, one request: the system prompt and the message
  assert.strictEqual(bodies[0].system.length, 1);
  // second turn with a tool round: round 1 and round 2
  bodies = recordFetch(env, [msgStart + tu(0, 'toolu_c1', 'read_lines', { start: 1, end: 3, doc: null }) + stopTool, textRound('Two.')]);
  await send(env, 'second');
  assert.strictEqual(bodies.length, 2);
  deq(breakpoints(bodies[0]), ['system:0', 'messages:0:0', 'messages:2:0']); // previous turn's message, the new message
  deq(breakpoints(bodies[1]), ['system:0', 'messages:0:0', 'messages:4:0']); // ... and the tool result of round 1
  assert.strictEqual(bodies[1].messages[4].content[0].type, 'tool_result');
  for (const b of bodies) assert.ok(breakpoints(b).length <= 4);
  // a third turn: the breakpoint moves to the second turn's user message
  bodies = recordFetch(env, [textRound('Three.')]);
  await send(env, 'third');
  const userIdx = bodies[0].messages.map((m, i) => (m.role === 'user' && m.content.some((c) => c.type === 'text' && c.text.endsWith('\n\nsecond')) ? i : -1)).filter((i) => i >= 0);
  assert.strictEqual(userIdx.length, 1);
  const last = bodies[0].messages.length - 1;
  deq(breakpoints(bodies[0]), ['system:0', `messages:${userIdx[0]}:${bodies[0].messages[userIdx[0]].content.length - 1}`, `messages:${last}:0`]);
  // the stored history carries no cache markers
  assert.ok(!JSON.stringify(state.messages).includes('cache_control'));
});

test('Anthropic: within a turn the request prefix is identical across rounds; thinking blocks replayed verbatim', async () => {
  useProvider(env, 'anthropic', { model: 'claude-opus-5-5' });
  await freshChat();
  doc.text = DOC_A; doc.selection = 'Alpha beta';
  await send(env, 'warm-up'); // a previous turn (default mock answer)
  const think = ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }) +
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Plan.' } }) +
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG' } }) +
    ev('content_block_stop', { type: 'content_block_stop', index: 0 });
  const bodies = recordFetch(env, [
    msgStart + think + tu(1, 'toolu_p1', 'read_lines', { start: 5, end: 7, doc: null }) + stopTool,
    msgStart + tu(0, 'toolu_p2', 'find_in_document', { query: 'Delta', doc: null }) + stopTool,
    textRound('Done.'),
  ]);
  doc.selection = 'Delta'; // the selection changes between turns, not within one
  await send(env, 'look around');
  assert.strictEqual(bodies.length, 3);
  for (let r = 1; r < bodies.length; r++) {
    const prev = bodies[r - 1];
    const cur = bodies[r];
    // everything before the messages is byte-identical
    assert.strictEqual(JSON.stringify(cur.system), JSON.stringify(prev.system), `round ${r + 1}: system`);
    assert.strictEqual(JSON.stringify(cur.tools), JSON.stringify(prev.tools), `round ${r + 1}: tools`);
    assert.strictEqual(JSON.stringify([cur.model, cur.thinking, cur.max_tokens]), JSON.stringify([prev.model, prev.thinking, prev.max_tokens]));
    // the earlier round's messages are a prefix of this round's (ignoring where the moving breakpoint sits)
    const a = JSON.stringify(stripCache(prev.messages));
    const b = JSON.stringify(stripCache(cur.messages.slice(0, prev.messages.length)));
    assert.strictEqual(b, a, `round ${r + 1}: message prefix`);
  }
  deq(bodies[1].messages[bodies[1].messages.length - 2].content[0], { type: 'thinking', thinking: 'Plan.', signature: 'SIG' }); // verbatim, no cache_control
});

test('OpenAI: prompt_cache_key = document ID + chat ID; instructions static; input prefix identical across rounds', async () => {
  useProvider(env, 'openai', { model: 'gpt-6.1-sol' });
  await freshChat();
  doc.text = DOC_A; doc.selection = 'Alpha beta';
  const bodies = recordFetch(env, [oaTool('call_o1', 'read_lines', { start: 1, end: 2, doc: null }), oaText('Done.')]);
  await send(env, 'read it');
  assert.strictEqual(bodies.length, 2);
  for (const b of bodies) assert.strictEqual(b.prompt_cache_key, `DOC123:${state.chatId}`);
  assert.strictEqual(bodies[1].instructions, bodies[0].instructions);
  assert.ok(!bodies[0].instructions.includes('Outline (line: heading)'));
  assert.strictEqual(JSON.stringify(bodies[1].input.slice(0, bodies[0].input.length)), JSON.stringify(bodies[0].input));
  assert.ok(bodies[0].input[0].content.startsWith('<document title="My Doc"'));
  // a long key keeps its end (the chat ID) within 64 characters
  const s = T.takeSnapshot(); T.snapshotDocument(s); s.docId = 'D'.repeat(80);
  const key = T.buildRequest('edit', s).body.prompt_cache_key;
  assert.strictEqual(key.length, 64); assert.ok(key.endsWith(':' + state.chatId));
});

test('Munin: static system message, context in the user message, prefix identical across rounds, older contexts shortened', async () => {
  useProvider(env, 'munin');
  await freshChat();
  doc.text = DOC_A; doc.selection = 'Alpha beta';
  let bodies = recordFetch(env, [muText('One.')]);
  await send(env, 'first');
  bodies = recordFetch(env, [muTool('call_m1', 'read_lines', { start: 1, end: 2, doc: null }), muText('Two.')]);
  doc.selection = 'Delta';
  await send(env, 'second');
  assert.strictEqual(bodies.length, 2);
  assert.strictEqual(bodies[0].messages[0].role, 'system');
  assert.ok(!bodies[0].messages[0].content.includes('Outline (line: heading)'));
  assert.strictEqual(JSON.stringify(bodies[1].messages.slice(0, bodies[0].messages.length)), JSON.stringify(bodies[0].messages));
  // the older turn's context is sent without its outline (Munin has no prompt cache to keep valid)
  assert.strictEqual(bodies[0].messages[1].content, `<document title="My Doc" format="markdown" lines="11" characters="${DOC_A.length}">[outline omitted: from an earlier message]</document>\n` +
    'Selection: line 7 (10 characters)\n\nfirst');
  assert.ok(bodies[0].messages[3].content.includes('Outline (line: heading):\nL1: # My Doc') && bodies[0].messages[3].content.endsWith('\n\nsecond')); // the current turn: in full
  assert.strictEqual(bodies[0].prompt_cache_key, undefined); // no extra parameters
  // a context stored before the selection became a line range: a long selection text is left out, its position stays
  const long = '<document title="X" lines="3">\nOutline\n</document>\nCurrent selection in the document:\n<selection lines="1-2">\n' + 'y'.repeat(400) + '\n</selection>';
  assert.strictEqual(T.shortContext(long), '<document title="X" lines="3">[outline omitted: from an earlier message]</document>\nCurrent selection in the document:\n<selection lines="1-2">[selected text omitted: from an earlier message]</selection>');
});

test('compaction transcript: the turn context in its short form', async () => {
  const msgs = [{ role: 'user', content: 'fix it', _context: '<document title="D" lines="3">\nOutline (line: heading):\nL1: # D\n</document>\nCurrent selection in the document:\n<selection lines="2-2">\nab\n</selection>' }];
  useProvider(env, 'anthropic');
  const s = T.takeSnapshot(); T.snapshotDocument(s);
  assert.strictEqual(T.compactionTranscript(msgs, 'edit', s),
    'User: fix it\n[Document state when sent: <document title="D" lines="3">[outline omitted: from an earlier message]</document> Current selection in the document: <selection lines="2-2"> ab </selection>]');
});
