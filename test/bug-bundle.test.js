'use strict';
// The bug bundle (src/chat-log.js: keepTurnStart, buildBugBundle; Alt+click on a chat's copy button, test/dom/chat-log.test.js):
// per kept turn the request and what the turn started from (the documents.get body as returned, else the export text; the
// selection with its lines, the mode, the instructions, the files' names), a document equal to the previous turn's kept
// once, the documents bounded with the records and in all (CHAT_LOG_DOC_CHARS), turns no longer kept marked, and no key,
// account id, server URL, token or image content link in the file.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, installIdentity } = require('./lib/sandbox');
const { fakeDocsServer, docsBench } = require('./lib/fake-docs');
const { docBench, recordFetch, useProvider, send, oaText } = require('./lib/context');
const { sseResponse } = require('./lib/streams');

const KEY = 'mu-SECRET-KEY-4711';
const TOKEN = 'ya29.GOOGLE-TOKEN-SECRET';
const cc = (o) => `data: ${JSON.stringify(o)}\n\n`;
const answer = (text, prompt) => cc({ choices: [{ index: 0, delta: { content: text } }] }) + cc({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
  cc({ choices: [], usage: { prompt_tokens: prompt, completion_tokens: 3 } }) + 'data: [DONE]\n\n';
const spec = () => ({
  documentId: 'DOC123', title: 'Bundle Doc',
  tabs: [{ id: 't.0', title: 'Main', items: [
    { p: 'Notes', style: 'HEADING_1' },
    { p: 'Teh first line.' },
    { p: 'A figure: ￼ here.', objects: [[10, { image: { id: 'kix.img1', title: 'Plot', description: 'Yield over time', width: 200, height: 100 } }]] },
    { p: 'Последняя строка.' },
  ] }],
});

let env, T, state, storage, ident, ref;

before(async () => {
  env = await load();
  ({ T, state, storage } = env);
  ident = installIdentity(env);
  ref = {};
  installDocTab(env);
  await T.refreshContext({ force: true });
});

test('Docs API turns: the body as the turn read it, kept once while unchanged; request, selection, mode, instructions, files; nothing secret', async () => {
  const { routeDocs } = docsBench(env, ident, ref);
  const fake = fakeDocsServer(spec());
  ref.fake = fake;
  fake.token = ident.token = TOKEN; ident.granted = true; ident.forget();
  useProvider(env, 'munin', { apiKey: KEY });
  state.googleConnected = true;
  storage[T.docInstructionsKey('DOC123')] = 'Use British spelling.';
  storage[T.filesKey('DOC123')] = [{ alias: 'doc2', title: 'Protocol.pdf', lines: 40, size: 1200 }];
  let selection = 'Teh first line.';
  env.chrome.tabs.sendMessage = async (id, msg) => (msg.type === 'GET_SELECTION' ? { ok: true, text: selection } : { ok: true, title: 'Bundle Doc' });
  await T.refreshContext({ force: true });
  await T.createChat();
  const bodies = [];
  const rounds = [answer('First.', 1000), answer('Second.', 1100), answer('Third.', 1200)];
  env.ctx.fetch = routeDocs(async (url, init) => { bodies.push(JSON.parse(init.body)); return sseResponse(rounds[bodies.length - 1]); });
  await send(env, 'Fix the typo.');
  selection = '';
  await send(env, 'And again?');
  fake.typeParagraph(1, 'Typed by the user.'); // the document changes between turns 2 and 3
  state.applyMode = 'manual';
  await send(env, 'What changed?');
  assert.strictEqual(bodies.length, 3);
  // a second account (its id, key and server URL), and a leak into the stored history (a result that quoted them):
  // removed from the file too; the chat's migrated account is named after its type ("munin"), which is no secret
  const lab = { id: 'a9xk2mq7zz', type: 'munin', name: 'Lab', apiKey: 'k-LAB-SECRET-123', baseUrl: 'https://lab.example.org/v1' };
  state.settings.accounts.push(lab);
  const accountId = lab.id;
  assert.strictEqual(T.activeConfig().accountId, 'munin');
  state.messages.push({ role: 'user', content: `key ${KEY}, token ${TOKEN}, ${lab.id} ${lab.apiKey} ${lab.baseUrl}, image https://lh3.googleusercontent.com/abc123=w200`, _auto: true });
  const kept = T.turnRequestsOf('DOC123', state.chatId);
  assert.strictEqual(kept.length, 3);
  // the start of a turn: the body as the turn read it (the same object while unchanged), the selection with its lines
  assert.strictEqual(kept[0].doc, kept[1].doc);
  assert.notStrictEqual(kept[1].doc, kept[2].doc);
  assert.strictEqual(kept[0].doc.format, 'docs-api');
  assert.strictEqual(JSON.parse(kept[0].doc.json).revisionId, 'rev-1');
  deq(kept[0].start, { mode: 'edit', selection: { text: 'Teh first line.', lines: [2, 2] }, docInstructions: 'Use British spelling.', mainInstructions: '',
    files: [{ alias: 'doc2', title: 'Protocol.pdf', kind: 'file' }], providerType: 'munin' });
  // the log's mode tells Manual from Auto: both are editing turns ('edit'); Manual's message carries _asks
  assert.strictEqual(kept[2].start.mode, 'manual');
  deq(state.messages.filter((m) => m.role === 'user' && !m._auto).map((m) => [m._mode, m._asks]), [['edit', undefined], ['edit', undefined], ['edit', true]]);
  deq(kept[1].start.selection, { text: '', lines: null });

  const secrets = await T.bundleSecrets();
  assert.ok(secrets.includes(KEY) && secrets.includes(TOKEN) && secrets.includes(accountId), secrets.join(', '));
  const b = T.buildBugBundle(state.messages, { title: 'Typo hunt', docTitle: 'Bundle Doc', model: 'qwen3.8-27b', at: 1762862400000 }, kept,
    { app: '1.1.2', secrets, now: Date.UTC(2026, 10, 11, 12) });
  const json = JSON.stringify(b);
  for (const s of [KEY, TOKEN, accountId, lab.apiKey, 'lab.example.org', 'googleusercontent', 'Bearer', 'Authorization']) assert.ok(!json.includes(s), `the bundle contains ${s}`);
  deq(Object.keys(b), ['kind', 'version', 'app', 'savedAt', 'chat', 'messages', 'systems', 'documents', 'turns']);
  deq([b.kind, b.version, b.app, b.savedAt], ['munin-bug-bundle', 1, '1.1.2', '2026-11-11T12:00:00.000Z']);
  deq(b.chat, { title: 'Typo hunt', docTitle: 'Bundle Doc', model: 'qwen3.8-27b', updatedAt: 1762862400000 });
  // the stored messages as they are (an account id inside _model redacted)
  assert.strictEqual(b.messages.length, state.messages.length);
  deq(b.messages.map((m) => m.content), [...state.messages.slice(0, -1).map((m) => m.content),
    'key [redacted], token [redacted], [redacted] [redacted] [redacted], image [redacted]']);
  assert.strictEqual(b.messages[0]._context, state.messages[0]._context);
  assert.strictEqual(b.messages[0]._model, state.messages[0]._model);
  state.settings.accounts.pop();
  // two documents for three turns; the image's content link removed, its title and description kept
  assert.strictEqual(b.documents.length, 2);
  deq(b.turns.map((t) => [t.message, t.kept, t.document]), [[0, true, 0], [2, true, 0], [4, true, 1]]);
  const img = b.documents[0].body.tabs[0].documentTab.inlineObjects['kix.img1'].inlineObjectProperties.embeddedObject;
  deq([img.title, img.description, img.imageProperties.contentUri], ['Plot', 'Yield over time', '[redacted]']);
  assert.strictEqual(b.documents[0].tabId, 't.0');
  assert.ok(JSON.stringify(b.documents[1].body).includes('Typed by the user.') && !JSON.stringify(b.documents[0].body).includes('Typed by the user.'));
  // the request of a turn: what keepTurnRequest keeps, the system prompt once
  const t0 = b.turns[0];
  deq([t0.provider, t0.providerType, t0.model, t0.measured], ['Munin', 'munin', T.activeConfig().model, 1000]);
  deq(t0.tools, bodies[0].tools.map((x) => x.function.name));
  assert.strictEqual(b.systems[t0.system], bodies[0].messages[0].content);
  assert.ok(t0.estimated > 0);
  deq([b.turns[2].mode, b.turns[2].selection.text], ['manual', '']);
  assert.ok(!('documentNote' in t0));
  storage[T.docInstructionsKey('DOC123')] = ''; storage[T.filesKey('DOC123')] = []; state.docInstructions = '';
  await T.refreshContext({ force: true });
});

test('the export path keeps the export text; a turn before the panel was opened is marked not kept; a turn without a document', async () => {
  state.googleConnected = false;
  const { doc } = docBench(env);
  doc.text = '# Notes\n\nTeh first line.';
  useProvider(env, 'openai', { apiKey: 'sk-OPENAI-SECRET-99' });
  await T.refreshContext({ force: true });
  await T.createChat();
  recordFetch(env, [oaText('Fine.')]);
  await send(env, 'Check line 3.');
  const older = [{ role: 'user', content: 'An older question.' }, { role: 'assistant', content: 'An older answer.' }];
  const list = [...older, ...state.messages];
  // a turn whose snapshot had no document (the read failed)
  const snap = { prov: { id: 'munin', label: 'Munin' }, cfg: { model: 'm' }, docText: null, docFormat: 'text', selection: '' };
  const lost = { role: 'user', content: 'No document here.' };
  T.keepTurnRequest({ docId: 'DOC123', chatId: state.chatId }, lost, { system: { head: 'S', tail: '' }, tools: [], messages: [] }, snap);
  list.push(lost, { role: 'assistant', content: 'Sorry.' });
  const b = T.buildBugBundle(list, { title: 'Export' }, T.turnRequestsOf('DOC123', state.chatId), { secrets: await T.bundleSecrets() });
  deq(b.turns.map((t) => [t.message, t.kept]), [[0, false], [2, true], [list.length - 2, true]]);
  assert.strictEqual(b.turns[0].note, 'Not kept: the panel keeps the last 30 turns of a chat since it was opened.');
  deq(Object.keys(b.turns[0]), ['message', 'kept', 'note']);
  deq(b.documents, [{ format: 'markdown', text: '# Notes\n\nTeh first line.' }]);
  deq([b.turns[1].document, b.turns[1].providerType], [0, 'openai']);
  deq([b.turns[2].document, b.turns[2].documentNote], [null, 'The turn had no document.']);
  assert.ok(!JSON.stringify(b).includes('sk-OPENAI-SECRET-99'));
});

test('documents are bounded in all: past CHAT_LOG_DOC_CHARS the ones used longest ago go and their turns say so; nothing stored', async () => {
  const small = await load({ consts: { CHAT_LOG_DOC_CHARS: 1000 } });
  const ctx = { docId: 'D9', chatId: 'c1', messages: [] };
  const snapOf = (text) => ({ prov: { id: 'munin', label: 'Munin' }, cfg: { model: 'm' }, docText: text, docFormat: 'markdown', selection: '' });
  const req = { system: { head: 'S', tail: '' }, tools: [], messages: [] };
  const msgs = [];
  const keep = (text, i) => { const m = { role: 'user', content: `m${i}` }; msgs.push(m, { role: 'assistant', content: 'ok' }); return small.T.keepTurnRequest(ctx, m, req, snapOf(text)); };
  const a = keep('a'.repeat(400), 0);
  const a2 = keep('a'.repeat(400), 1); // unchanged: the same object, counted once
  assert.strictEqual(a.doc, a2.doc);
  keep('b'.repeat(400), 2);
  keep('c'.repeat(400), 3); // 1,200 characters of distinct documents: the oldest goes
  const b = small.T.buildBugBundle(msgs, {}, small.T.turnRequestsOf('D9', 'c1'));
  deq(b.turns.map((t) => t.document), [null, null, 0, 1]);
  assert.strictEqual(b.turns[0].documentNote, 'No longer in memory (the panel keeps a bounded number of document versions).');
  deq(b.documents.map((d) => d.text[0]), ['b', 'c']);
  // a turn record evicted with its chat (at most 10 chats) takes its document along: nothing in chrome.storage
  for (let i = 0; i < 10; i++) small.T.keepTurnRequest({ docId: 'D9', chatId: `x${i}` }, { role: 'user', content: 'q' }, req, snapOf('d'));
  assert.strictEqual(small.T.turnRequestsOf('D9', 'c1').length, 0);
  assert.ok(!Object.keys(small.storage).some((k) => /bundle|request/i.test(k)), Object.keys(small.storage).join(', '));
});

test('the file name: a slug of the title in any script, and the date', () => {
  const ts = new Date(2026, 10, 11, 14, 5).getTime();
  assert.strictEqual(T.bugBundleName('Fix the «typos» in §2!', ts), 'munin-bug-fix-the-typos-in-2-2026-11-11.json');
  assert.strictEqual(T.bugBundleName('Проверь ссылки', ts), 'munin-bug-проверь-ссылки-2026-11-11.json');
  assert.strictEqual(T.bugBundleName('', ts), 'munin-bug-chat-2026-11-11.json');
  assert.strictEqual(T.bugBundleName('x'.repeat(60), ts), `munin-bug-${'x'.repeat(40)}-2026-11-11.json`);
});

test('redaction: every contentUri, image links in any text, and secrets anywhere; short strings are not secrets', () => {
  const v = T.redactBundle({ a: [{ contentUri: 'https://x.example/img' }], b: 'see https://lh5.googleusercontent.com/docsz/AbC?key=1 and k-ABCDEF.', c: 'abc' },
    ['k-ABCDEF', 'abc', null]);
  deq(v, { a: [{ contentUri: '[redacted]' }], b: 'see [redacted] and [redacted].', c: 'abc' });
  // the API's contentUri host (docs.google.com, an images path), also under /u/N/; a document's own link stays
  const d = T.redactBundle({ t: 'img https://docs.google.com/docs-images-rt/AD_4nXabc?key=Zz9 and (https://docs.google.com/u/1/docs-images-rt/X1), '
    + 'doc https://docs.google.com/document/d/1AbC/edit?tab=t.0 and HTTPS://LH7-RT.GOOGLEUSERCONTENT.COM/docsz/Q' }, []);
  assert.strictEqual(d.t, 'img [redacted] and ([redacted]), doc https://docs.google.com/document/d/1AbC/edit?tab=t.0 and [redacted]');
});
