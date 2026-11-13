'use strict';
// The fuller chat log (src/chat-log.js: buildChatLog with the kept requests, Shift+click on a chat's copy button): what
// the first request of each turn sent (the system prompt once, then only its changes; per turn the context, the tools
// offered, the provider and model, the estimated and the measured prompt tokens), kept in memory only (keepTurnRequest:
// the last 30 turns of a chat, at most 10 chats), a turn before the panel was opened marked as not available, a Munin
// persona turn, no key, header or account id; the plain log unchanged.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load } = require('./lib/sandbox');
const { ev } = require('./lib/streams');
const { docBench, recordFetch, useProvider, send } = require('./lib/context');

let env, T, state, storage, doc;
const KEY = 'mu-SECRET-KEY-4711';
const cc = (o) => `data: ${JSON.stringify(o)}\n\n`;
// A Munin answer with the usage chunk the server sends last (include_usage).
const answer = (text, prompt) => cc({ choices: [{ index: 0, delta: { content: text } }] }) + cc({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
  cc({ choices: [], usage: { prompt_tokens: prompt, completion_tokens: 3 } }) + 'data: [DONE]\n\n';
const indent = (s) => s.split('\n').map((l) => (l ? '  ' + l : l)).join('\n');

before(async () => {
  env = await load();
  ({ T, state, storage } = env);
  ({ doc } = docBench(env));
  doc.text = '# Notes\n\nTeh first line.\nThe second line.';
  await T.refreshContext({ force: true });
});

test('two Munin turns: the system prompt once, each turn\'s context, request and tools; the change of the prompt; an older turn not kept; no key', async () => {
  useProvider(env, 'munin', { apiKey: KEY });
  await T.createChat();
  const bodies = recordFetch(env, [answer('Fixed nothing yet.', 1234), answer('British it is.', 1500)]);
  await send(env, 'Fix the typos.');
  storage['muninDocInstructions:DOC123'] = 'Use British spelling.'; state.docInstructions = 'Use British spelling.';
  await send(env, 'And the spelling?');
  assert.strictEqual(bodies.length, 2);
  const chatId = state.chatId;
  const kept = T.turnRequestsOf('DOC123', chatId);
  assert.strictEqual(kept.length, 2);
  // an older turn (from before the panel was opened) in front of the two
  const older = [{ role: 'user', content: 'An older question.', _context: '[Document: 4 lines]' }, { role: 'assistant', content: 'An older answer.' }];
  const list = [...older, ...state.messages];
  const log = T.buildChatLog(list, { title: 'Typos' }, kept);
  const blocks = log.trimEnd().split('\n\n');
  assert.strictEqual(blocks[0], 'Chat: Typos');
  // the system prompt of the first kept turn, as sent (Munin: the system message)
  assert.strictEqual(bodies[0].messages[0].role, 'system');
  assert.strictEqual(log.split('\n\nUser:\n')[0], `Chat: Typos\n\nSystem prompt:\n${indent(bodies[0].messages[0].content)}`);
  const at = (text) => blocks.findIndex((b) => b.includes(text));
  // the older turn: its context, and that its request is not kept
  assert.strictEqual(blocks[at('An older question.')], 'User:\nAn older question.\nContext:\n  [Document: 4 lines]\n' +
    'Request: not available (the panel keeps the requests of the last 30 turns of a chat since it was opened).');
  // the first kept turn: the context as stored, the request (provider, model, tokens) and the tools as sent
  const first = state.messages[0];
  const model = T.activeConfig().model;
  const est = T.estimateTokens(bodies[0].messages, JSON.stringify(bodies[0].tools).length);
  assert.strictEqual(blocks[at('Fix the typos.')], `User (Auto):\nFix the typos.\nContext:\n${indent(first._context)}\n` +
    `Request: Munin · ${model} · about ${est.toLocaleString('en-US')} tokens estimated, 1,234 measured\n` +
    `Tools: ${bodies[0].tools.map((t) => t.function.name).join(', ')}`);
  // the second turn: the DOC.md lines as the change of the prompt, not the whole prompt again
  const second = blocks[at('And the spelling?')];
  assert.ok(second.includes('1,500 measured\nTools: ') && second.includes('\nSystem prompt changed:\n'), second);
  const change = second.split('\nSystem prompt changed:\n')[1].split('\n');
  assert.ok(change.includes('  + Use British spelling.') && change.every((l) => /^ {2}[+-](?: \S|$)/.test(l)), change.join('\n'));
  assert.ok(second.length < bodies[1].messages[0].content.length);
  // the answers in between, as the plain log has them
  assert.ok(log.includes('\n\nAssistant:\nFixed nothing yet.\n\n'));
  // no key, header, URL or account id
  assert.ok(!log.includes(KEY) && !/Bearer|Authorization|Content-Type|muninai\.org/.test(log), 'a secret in the log');
  const account = T.activeConfig().accountId;
  if (account && account.length > 6) assert.ok(!log.includes(account));
  // the plain log stays as it was: no prompt, context or request
  const plain = T.buildChatLog(list, { title: 'Typos' });
  assert.strictEqual(plain, T.buildChatLog(list, { title: 'Typos' }, null));
  assert.ok(!/System prompt|Context:|Request:|Tools:/.test(plain) && !plain.includes('[Document: 4 lines]'), plain);
  storage['muninDocInstructions:DOC123'] = ''; state.docInstructions = '';
});

test('a chat without a kept request: one line after the header; a repeated message takes the next request; a Munin persona turn', async () => {
  const msgs = [{ role: 'user', content: 'Hi.' }, { role: 'assistant', content: 'Hello.' }];
  deq(T.buildChatLog(msgs, { title: 'X' }, []).split('\n\n').slice(0, 2), ['Chat: X',
    'System prompt: not available (the panel keeps the requests of the last 30 turns of a chat since it was opened).']);
  // the same words twice with the same context: matched in order
  const snap = { prov: { id: 'munin', label: 'Munin' }, cfg: { model: 'm', apiKey: KEY } };
  const ctx = { docId: 'D2', chatId: 'c2', messages: [] };
  const u1 = { role: 'user', content: 'again', _context: 'C' };
  const u2 = { role: 'user', content: 'again', _context: 'C' };
  T.keepTurnUsage(T.keepTurnRequest(ctx, u1, { system: { head: 'S', tail: '' }, tools: [], messages: [] }, snap), { prompt_tokens: 11 });
  T.keepTurnUsage(T.keepTurnRequest(ctx, u2, { system: { head: 'S', tail: '' }, tools: [], messages: [] }, snap), { prompt_tokens: 22 });
  const log = T.buildChatLog([u1, { role: 'assistant', content: 'a' }, u2, { role: 'assistant', content: 'b' }], {}, T.turnRequestsOf('D2', 'c2'));
  assert.ok(log.includes('Request: Munin · m · about 0 tokens estimated, 11 measured\nTools: none') && log.includes('22 measured'), log);
  assert.ok(!log.includes('System prompt changed')); // the same prompt
  // a persona turn: its request (the instructions and the document go in the user message; no tools)
  useProvider(env, 'munin', { apiKey: KEY });
  await T.createChat();
  const bodies = recordFetch(env, [ev('token', { content: 'Found it.' }) + ev('done', { usage: { prompt_tokens: 900, completion_tokens: 4 } })]);
  await send(env, '/research lipid rafts');
  assert.strictEqual(bodies.length, 1);
  assert.strictEqual(bodies[0].persona, 'research');
  const full = T.buildChatLog(state.messages, {}, T.turnRequestsOf('DOC123', state.chatId));
  assert.match(full, /\nRequest: Munin · [^\n]+ · about [\d,]+ tokens estimated, 900 measured\nTools: none/);
  assert.match(full, /^Chat: [^\n]*\n\nSystem prompt:\n {2}\S/);
});

test('kept in memory only, bounded: the last 30 turns of a chat, at most 10 chats; a resend updates its turn\'s record; nothing stored', () => {
  const snap = { prov: { id: 'openai', label: 'OpenAI' }, cfg: { model: 'gpt', apiKey: KEY, accountId: 'acc-7' } };
  const req = (system) => ({ system: { head: system, tail: '' }, tools: [{ type: 'function', function: { name: 'read_document', description: 'd', parameters: {} } }], messages: [{ role: 'user', content: 'x'.repeat(30) }] });
  const ctx = { docId: 'D3', chatId: 'many', messages: [] };
  for (let i = 0; i < 35; i++) T.keepTurnRequest(ctx, { role: 'user', content: `m${i}` }, req('S'), snap);
  const kept = T.turnRequestsOf('D3', 'many');
  assert.strictEqual(kept.length, 30);
  assert.strictEqual(kept[0].key, T.logMsgKey({ content: 'm5' }));
  deq(Object.keys(kept[0]).sort(), ['doc', 'estimated', 'key', 'measured', 'model', 'provider', 'start', 'system', 'tools']);
  assert.ok(!JSON.stringify(kept).includes(KEY) && !JSON.stringify(kept).includes('acc-7'));
  // a resend of the same turn's first request (less context): the same record, updated
  const u = { role: 'user', content: 'big' };
  const rec = T.keepTurnRequest(ctx, u, req('S'), snap);
  const again = T.keepTurnRequest(ctx, u, { ...req('S'), messages: [] }, snap, rec);
  assert.strictEqual(again, rec);
  assert.strictEqual(T.turnRequestsOf('D3', 'many').length, 30);
  assert.ok(rec.estimated < T.turnRequestsOf('D3', 'many')[0].estimated);
  // at most 10 chats: the one used longest ago goes
  for (let i = 0; i < 10; i++) T.keepTurnRequest({ docId: 'D3', chatId: `c${i}` }, { role: 'user', content: 'q' }, req('S'), snap);
  assert.strictEqual(T.turnRequestsOf('D3', 'many').length, 0);
  assert.strictEqual(T.turnRequestsOf('D3', 'c0').length, 1);
  // nothing in chrome.storage
  assert.ok(!Object.keys(storage).some((k) => /request/i.test(k)), Object.keys(storage).join(', '));
  // no chat (a side question) or no request: nothing kept
  assert.strictEqual(T.keepTurnRequest({ docId: 'D3', chatId: null }, u, req('S'), snap), null);
});
