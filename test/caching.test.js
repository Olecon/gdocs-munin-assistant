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
  // One provider with a key: no Agents line in the context (test/agents.test.js has it).
  for (const id of ['openai', 'munin']) state.settings.providers[id].apiKey = '';
  await freshChat();
  T.ownBaselines.clear(); // the earlier tests' last text would give an own-changes line (own-changes.js)
  const bodies = recordFetch(env, [textRound('One.')]);
  doc.text = DOC_A; doc.selection = 'Alpha beta';
  await send(env, 'first');
  // a short selection comes with its text; the first turn names the model
  const CTX_A = '<document title="My Doc" format="markdown" lines="11" characters="' + DOC_A.length + '">\nOutline (line: heading):\nL1: # My Doc\nL5: ## Methods\nL9: ## Results\n</document>\n' +
    'Selection: line 7 (10 characters)\nIts text (no need for get_selection):\n<selection>\nAlpha beta\n</selection>\nYou run as claude-opus-5-5 (Anthropic (Claude)).';
  assert.strictEqual(state.messages[0]._context, CTX_A);
  assert.strictEqual(state.messages[0].content, 'first'); // the user's own text is stored separately
  deq(bodies[0].messages, [{ role: 'user', content: [{ type: 'text', text: `${CTX_A}\n\nfirst`, cache_control: EPH }] }]);
  // the next turn: its own context (new outline, new selection, a changes note); the first turn's message is unchanged
  doc.text = DOC_B; doc.selection = 'Delta';
  await send(env, 'second');
  assert.strictEqual(state.messages[0]._context, CTX_A);
  const ctxB = state.messages[2]._context;
  assert.ok(ctxB.startsWith(`<document title="My Doc" format="markdown" lines="15" characters="${DOC_B.length}">\nOutline (line: heading):\nL1: # My Doc\nL7: ## Methods\nL11: ## Results\nL15: ## Discussion\n</document>\n<document_changes>`));
  assert.ok(ctxB.endsWith('\nSelection: line 13 (5 characters)\nIts text (no need for get_selection):\n<selection>\nDelta\n</selection>'));
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

test('OpenAI: prompt_cache_key = account ID + document ID + chat ID; instructions static; input prefix identical across rounds', async () => {
  useProvider(env, 'openai', { model: 'gpt-6.1-sol' });
  await freshChat();
  doc.text = DOC_A; doc.selection = 'Alpha beta';
  const bodies = recordFetch(env, [oaTool('call_o1', 'read_lines', { start: 1, end: 2, doc: null }), oaText('Done.')]);
  await send(env, 'read it');
  assert.strictEqual(bodies.length, 2);
  for (const b of bodies) assert.strictEqual(b.prompt_cache_key, `openai:DOC123:${state.chatId}`); // the account id first
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
  // the older turn's context is sent without its <document> block, run-as line and selection text (Munin has no prompt
  // cache to keep valid); the stored one keeps them
  assert.strictEqual(bodies[0].messages[1].content, 'Selection: line 7 (10 characters)\n\nfirst');
  assert.ok(state.messages[0]._context.includes('<selection>\nAlpha beta\n</selection>'));
  const cur = bodies[0].messages[3].content; // the current turn: in full
  assert.ok(cur.includes('Outline (line: heading):\nL1: # My Doc') && cur.includes('\n<selection>\nDelta\n</selection>\n') && cur.endsWith('\n\nsecond'), cur);
  assert.strictEqual(bodies[0].prompt_cache_key, undefined); // no extra parameters
  // a context stored before the selection became a line range: a long selection text is left out, its position stays
  const long = '<document title="X" lines="3">\nOutline\n</document>\nCurrent selection in the document:\n<selection lines="1-2">\n' + 'y'.repeat(400) + '\n</selection>';
  assert.strictEqual(T.shortContext(long), 'Current selection in the document:\n<selection lines="1-2">[selected text omitted: from an earlier message]</selection>');
  // <document_changes> and the selection line stay; the style, run-as and Agents lines go
  const ctx = '<document title="X" lines="3">\nOutline (line: heading):\nL1: # X\n</document>\n[Comments: 1 open thread, 0 open suggested changes.]\nStyle of the document: average sentence 9 words.\n' +
    '<document_changes>Since your last turn: +1 line.</document_changes>\nSelection: line 2 (5 characters)\nYou run as qwen3.8-27b (Munin).\nAgents: delegate runs on x.';
  assert.strictEqual(T.shortContext(ctx), '[Comments: 1 open thread, 0 open suggested changes.]\n<document_changes>Since your last turn: +1 line.</document_changes>\nSelection: line 2 (5 characters)');
  // the text of a shown selection goes, whatever the selection line says (not found, several places); the rest stays
  const shown = (line) => `${line}\nIts text (no need for get_selection):\n<selection>\nfirst line\n\nsecond line\n</selection>\nYou run as x (Munin).`;
  for (const line of ['Selection: lines 2–4 (25 characters)', 'Selection: 25 characters; its position in the document was not found.',
    'Selection: 25 characters; the same text is on lines 2 and 4, so which one is selected is not known. replace_selection replaces exactly what the user selected. ' +
    'Other edits: only the place the request means ("this heading": the heading line), or ask the user; never all of them.']) {
    assert.strictEqual(T.shortContext(shown(line)), line);
  }
});

test('Munin: an older turn\'s write-call arguments go clipped (valid JSON, "…" at the cut); the stored history and the current turn keep them whole', () => {
  const long = 'x'.repeat(500);
  const call = (id, name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  const history = [
    { role: 'user', content: 'one' },
    call('w1', 'edit_document', { operations: [{ op: 'replace', old_text: 'short', new_text: long, line: 3 }] }),
    { role: 'tool', tool_call_id: 'w1', content: 'Done.' },
    call('r1', 'find_in_document', { query: long, doc: null }),
    { role: 'tool', tool_call_id: 'r1', content: 'none' },
    { role: 'user', content: 'two' },
    call('w2', 'insert_after_line', { line: 1, text: long, style: null }),
  ];
  const stored = JSON.stringify(history);
  const sent = T.buildApiMessages(true, history, 'S', { shortOld: true });
  const args = (i) => JSON.parse(sent[i].tool_calls[0].function.arguments);
  deq(args(2), { operations: [{ op: 'replace', old_text: 'short', new_text: 'x'.repeat(200) + '…', line: 3 }] });
  assert.strictEqual(args(4).query, long); // a reading call is not clipped
  assert.strictEqual(args(7).text, long); // the current turn: whole
  assert.strictEqual(JSON.stringify(history), stored);
  // a provider with a prompt cache: the history as it was (the cached prefix)
  assert.strictEqual(JSON.parse(T.buildApiMessages(true, history, 'S').at(2).tool_calls[0].function.arguments).operations[0].new_text, long);
});

test('compaction transcript: the turn context in its short form', async () => {
  const msgs = [{ role: 'user', content: 'fix it', _context: '<document title="D" lines="3">\nOutline (line: heading):\nL1: # D\n</document>\nCurrent selection in the document:\n<selection lines="2-2">\nab\n</selection>' }];
  useProvider(env, 'anthropic');
  const s = T.takeSnapshot(); T.snapshotDocument(s);
  assert.strictEqual(T.compactionTranscript(msgs, 'edit', s),
    'User: fix it\n[Document state when sent: Current selection in the document: <selection lines="2-2"> ab </selection>]');
});

test('keyword offers stay offered in a chat on OpenAI and Anthropic (tools and head unchanged afterwards); Munin offers per message', async () => {
  const names = (prov, b) => (b.tools || []).map((t) => t.name || (t.function && t.function.name) || t.type);
  const sys = (prov, b) => (prov === 'anthropic' ? b.system : prov === 'openai' ? b.instructions : b.messages[0]);
  for (const prov of ['anthropic', 'openai', 'munin']) {
    useProvider(env, prov);
    await freshChat();
    const round = () => (prov === 'anthropic' ? textRound('Ok.') : prov === 'openai' ? oaText('Ok.') : muText('Ok.'));
    const bodies = recordFetch(env, [round(), round(), round(), round()]);
    doc.text = DOC_A; doc.selection = '';
    await send(env, 'Shorten the intro.');
    await send(env, 'Add references for the Methods claims.');
    await send(env, 'Now fix the typo in the Results.');
    await send(env, 'Thanks, make the intro one sentence.');
    assert.strictEqual(bodies.length, 4, prov);
    assert.ok(!names(prov, bodies[0]).includes('find_reference'), `${prov}: not offered before a mention`);
    assert.ok(names(prov, bodies[1]).includes('find_reference'), `${prov}: offered on the mention`);
    if (prov === 'munin') {
      // no prompt cache: the offer follows the newest message, so an unrelated turn stays small
      assert.ok(!names(prov, bodies[2]).includes('find_reference'), 'munin: the next plain turn');
      deq(bodies[2].tools, bodies[0].tools, 'munin: back to the plain tool set');
    } else {
      for (const i of [2, 3]) {
        deq(bodies[i].tools, bodies[1].tools, `${prov}: tools identical on turn ${i + 1}`);
        deq(sys(prov, bodies[i]), sys(prov, bodies[1]), `${prov}: head identical on turn ${i + 1}`);
      }
    }
  }
});
