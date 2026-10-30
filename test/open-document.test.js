'use strict';
// open_document: the Docs API and export paths, aliases and the doc parameter, persistence per chat, the
// permission gate (Allow / Deny / Allow all), lazy re-reads.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, waitFor, load, installDocTab, installIdentity } = require('./lib/sandbox');
const { fakeDocsServer, WRITE_SET, docsBench } = require('./lib/fake-docs');

let fake; let as; // the fake Docs server and the turn snapshot; fresh() replaces both
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, D, C, state, PROVIDERS, sandbox, storage, chrome, ident, fresh, REF_ID, fake2, EXP_ID, OLD_ID, unreadable,
    tabCalls, docsRouter, exportCalls, exportFetch, od, os3;
const pending = () => [...T.pendingPreviews.entries()].map(([id, p]) => ({ id, card: p.card }));

before(async () => {
  env = await load();
  T = D = C = env.T;
  state = env.state;
  PROVIDERS = env.PROVIDERS;
  sandbox = env.ctx;
  storage = env.storage;
  chrome = env.chrome;
  ident = installIdentity(env);
  ({ fresh } = docsBench(env, ident, ref));
  installDocTab(env);
  await T.refreshContext({ force: true });
  state.googleConnected = true;
});

test('open_document through the Docs API: alias, outline, reading with "doc", errors, nothing written', async () => {
  // --- open_document through the Docs API (connected): alias, outline, reading with "doc", errors, persistence
  REF_ID = 'REFDOC22222222222222222222';
  fake2 = fakeDocsServer({ documentId: REF_ID, title: 'Reference paper', tabs: [{ id: 't.0', title: 'Main', items: [
    { p: 'Reference paper', style: 'TITLE' }, { p: 'Background', style: 'HEADING_1' }, { p: 'Lipid rafts are small.' },
    { p: 'Results', style: 'HEADING_1' }, { p: 'Rafts move fast.' },
  ] }] });
  const NOACCESS_ID = 'NOACCESS3333333333333333333';
  EXP_ID = 'EXPORTDOC4444444444444444444';
  OLD_ID = 'OLDSCRIPT5555555555555555555';
  unreadable = new Set([NOACCESS_ID]);
  await fresh();
  // The user named these documents (no confirmation needed, see the gate checks below).
  state.messages.push({ role: 'user', content: `Compare with https://docs.google.com/document/d/${REF_ID}/edit; also ${NOACCESS_ID}, ${EXP_ID} and ${OLD_ID}.` });
  // The content script exports other documents same-origin (GET_DOC_TEXT with docId); an old content
  // script ignores docId and answers for the main document.
  tabCalls = [];
  chrome.tabs.sendMessage = async (id, msg) => {
    if (msg.type === 'GET_DOC_TEXT' && msg.docId) {
      tabCalls.push({ docId: msg.docId, authuser: msg.authuser });
      if (unreadable.has(msg.docId)) return { ok: false, error: 'Export returned HTML (no access or sign-in required)', docId: msg.docId };
      if (msg.docId === EXP_ID) return { ok: true, text: '# Notes\n\nFirst \\- point\\.\n\n## Part two\n\nSecond point.', format: 'markdown', title: 'Notes ü', docId: EXP_ID };
      if (msg.docId.startsWith('GATE')) return { ok: true, text: '# Gate\n\nGate text.', format: 'markdown', title: 'Gate doc', docId: msg.docId };
      return { ok: true, text: 'MAIN DOCUMENT', format: 'markdown', title: 'My Doc', docId: 'DOC123' };
    }
    return msg.type === 'GET_SELECTION' ? { ok: true, text: '' } : { ok: true, title: 'My Doc', text: '' };
  };
  docsRouter = (other) => async (url, init) => {
    if (url.startsWith('https://docs.googleapis.com/')) return (url.includes(REF_ID) ? fake2 : fake).fetch(url, init); // other ids: HTTP 404
    if (other) return other(url, init);
    throw new Error('unexpected fetch ' + url);
  };
  exportCalls = [];
  exportFetch = async (url) => {
    exportCalls.push(url);
    if ([...unreadable].some((u) => url.includes(u))) return { ok: true, status: 200, text: async () => '<!DOCTYPE html><html>Sign in</html>', headers: { get: () => null } };
    return { ok: true, status: 200, headers: { get: (h) => (h === 'content-disposition' ? 'attachment; filename="Notes.md"; filename*=UTF-8\'\'Notes%20%C3%BC.md' : null) },
      text: async () => '# Notes\n\nFirst \\- point\\.\n\n## Part two\n\nSecond point.' };
  };
  sandbox.fetch = docsRouter(exportFetch);
  state.settings.provider = 'anthropic'; state.applyMode = 'auto'; state.googleConnected = true;
  let os = T.takeSnapshot(); T.snapshotDocument(os);
  os.chatCtx = { docId: 'DOC123', chatId: state.chatId, messages: state.messages };
  os.mainUrl = 'https://docs.google.com/document/u/1/d/DOC123/edit';
  deq(os.docs, []);
  deq(T.toolsFor('edit', os).map((t) => t.function.name), ['get_outline', 'read_lines', 'find_in_document', 'get_selection', 'read_formatting', 'open_document', 'remember', ...WRITE_SET, 'replace_selection', 'ask_user', 'table', 'page_parts', 'read_comments', 'draft', 'revise_section']);
  const call = (id, name, args) => T.executeTool({ id, function: { name, arguments: JSON.stringify(args) } }, 'edit', os);
  od;
  deq(C.parseDocRef(`https://docs.google.com/document/u/2/d/${REF_ID}/edit?tab=t.0#heading=h.x`), { id: REF_ID, tab: 't.0', authuser: '2' });
  deq(C.parseDocRef(`docs.google.com/document/d/${REF_ID}/edit`), { id: REF_ID, tab: null, authuser: null });
  deq(C.parseDocRef(REF_ID), { id: REF_ID, tab: null, authuser: null });
  assert.strictEqual(C.parseDocRef('https://docs.google.com/spreadsheets/d/abc/edit'), null);
  assert.strictEqual(C.parseDocRef('short'), null);
  deq(C.parseDocRef(`https://docs.google.com/a/example.org/document/d/${REF_ID}/edit`), { id: REF_ID, tab: null, authuser: null });
  deq(C.parseDocRef('https://docs.google.com/document/d/e/2PACX-1vTpublishedId/pub'), { published: true });
  od = null;
  od = await call('o1', 'open_document', { url: `https://docs.google.com/document/d/${REF_ID}/edit` });
  assert.strictEqual(T.pendingPreviews.size, 0); // named by the user: no confirmation
  assert.strictEqual(od.content, 'Opened as doc2. Title: "Reference paper". 5 lines, 74 characters.\nOutline (line: heading):\n' +
    'L1: [Title] Reference paper\nL2: [H1] Background\nL4: [H1] Results\nRead it with read_lines, find_in_document and get_outline with doc: "doc2". It is read-only.');
  assert.ok(od._ok && od._reading); assert.strictEqual(od._message, 'doc2: Reference paper');
  assert.strictEqual(fake2.log.length, 1); assert.strictEqual(exportCalls.length, 0); // read through the API
  deq(os.docs, [{ alias: 'doc2', id: REF_ID, title: 'Reference paper', lines: 5 }]);
  deq(storage['muninChats:DOC123'].find((c) => c.id === state.chatId).docs, [{ alias: 'doc2', id: REF_ID, title: 'Reference paper', lines: 5 }]); // persisted per chat
  let rd = await call('r1', 'read_lines', { start: 3, end: 5, doc: 'doc2' });
  assert.strictEqual(rd.content, 'Lines 3-5 of 5:\n3: Lipid rafts are small.\n4: Results\n5: Rafts move fast.');
  assert.strictEqual(rd._message, 'lines 3–5 (doc2)');
  assert.strictEqual((await call('r2', 'find_in_document', { query: 'RAFTS', doc: 'DOC2' })).content, '2 lines contain "RAFTS":\n3: Lipid rafts are small.\n5: Rafts move fast.');
  assert.strictEqual((await call('r3', 'get_outline', { doc: 'doc2' })).content, '3 headings (5 lines in total):\nL1: [Title] Reference paper\nL2: [H1] Background\nL4: [H1] Results');
  assert.strictEqual((await call('r4', 'read_lines', { start: 1, end: 1, doc: null })).content, 'Lines 1-1 of 10:\n1: Report 📊'); // null: the main document
  assert.strictEqual(fake2.log.length, 1); // read once in this turn
  // errors: unknown alias, get_selection and writes on an opened document, the main document, bad links, no access
  assert.strictEqual((await call('e1', 'read_lines', { start: 1, end: 2, doc: 'doc9' })).content,
    'Error: no document "doc9" is open in this chat (opened: doc2). Open it with open_document first, or pass doc: null for the main document.');
  assert.strictEqual((await call('e2', 'get_selection', { doc: 'doc2' })).content, 'Error: get_selection works only on the main document (omit doc or pass null).');
  let wr = await call('e3', 'replace_text', { old_text: 'Rafts', new_text: 'X', doc: 'doc2' });
  assert.ok(!wr._ok && wr.content === 'Error: replace_text edits only the main document; documents opened with open_document are read-only. Call it again without doc.');
  assert.ok(fake2.log.every((x) => x.method === 'GET') && fake.log.every((x) => x.method === 'GET')); // nothing written
  assert.strictEqual((await call('e4', 'open_document', { url: 'https://docs.google.com/document/d/DOC123/edit' })).content,
    'This is the main document (the one in <document>). Read it without the doc parameter (doc: null).');
  od = await call('e5', 'open_document', { url: 'https://example.com/file' });
  assert.ok(!od._ok && od.content === 'Error: "https://example.com/file" is not a Google Docs document link or ID. Pass a link like https://docs.google.com/document/d/<id>/edit or the document ID.');
  od = await call('e6', 'open_document', { url: NOACCESS_ID }); // API 404, then the export answers with a sign-in page
  assert.ok(!od._ok);
  assert.strictEqual(od.content, `Error: could not open the document ${NOACCESS_ID} (Google Docs API: The Docs API cannot find this document (HTTP 404): the connected Google account probably has no access to it (is it the account you use in this tab?). ` +
    'export: Export returned HTML (no access or sign-in required); export returned HTML (no access)). The user may have no access to it with the Google account of this tab, or the link is wrong.');
  deq(tabCalls, [{ docId: NOACCESS_ID, authuser: '1' }]); // the content-script export first, the panel's as the fallback
  od = await call('e7', 'open_document', { url: 'https://docs.google.com/document/d/e/2PACX-1vTpublishedId/pub' });
  assert.ok(!od._ok && od.content.startsWith('Error: this is a link to a published copy (/document/d/e/.../pub)'));
  deq(exportCalls, [`https://docs.google.com/document/d/${NOACCESS_ID}/export?format=md&authuser=1`, `https://docs.google.com/document/d/${NOACCESS_ID}/export?format=txt&authuser=1`]);
  // the same document again keeps its alias (and is read again)
  od = await call('o2', 'open_document', { url: REF_ID });
  assert.ok(od.content.startsWith('Already open as doc2; read again. Title: "Reference paper".')); assert.strictEqual(fake2.log.length, 2);
  deq(os.docs.map((d) => d.alias), ['doc2']);
  // the action log row of the call
  deq(T.actionLogFromToolCalls([{ id: 'o1', function: { name: 'open_document', arguments: JSON.stringify({ url: REF_ID }) } }]),
    [{ log: true, name: 'open_document', summary: REF_ID, args: { url: REF_ID }, result: null, status: 'pending' }]);
});

test('open_document without a Google account: content-script export (panel export as fallback), authuser, title, Markdown cleanup', async () => {
  // --- not connected: the export path (Markdown, authuser of the main document, title from the file name)
  state.googleConnected = false;
  let os2 = T.takeSnapshot(); T.snapshotDocument(os2);
  os2.chatCtx = { docId: 'DOC123', chatId: state.chatId, messages: state.messages };
  os2.mainUrl = 'https://docs.google.com/document/u/1/d/DOC123/edit';
  deq(os2.docs, [{ alias: 'doc2', id: REF_ID, title: 'Reference paper', lines: 5 }]); // from the chat meta
  exportCalls.length = 0; tabCalls.length = 0;
  od = await T.executeTool({ id: 'x1', function: { name: 'open_document', arguments: JSON.stringify({ url: `https://docs.google.com/document/d/${EXP_ID}/edit` }) } }, 'manual', os2);
  assert.strictEqual(od.content, 'Opened as doc3. Title: "Notes ü". 7 lines, 51 characters.\nOutline (line: heading):\nL1: # Notes\nL5: ## Part two\n' +
    'Read it with read_lines, find_in_document and get_outline with doc: "doc3". It is read-only.');
  deq(tabCalls, [{ docId: EXP_ID, authuser: '1' }]); deq(exportCalls, []); // exported by the content script
  assert.strictEqual((await T.executeTool({ id: 'x2', function: { name: 'read_lines', arguments: '{"start":3,"end":3,"doc":"doc3"}' } }, 'manual', os2)).content, 'Lines 3-3 of 7:\n3: First - point.'); // export escapes removed
  assert.strictEqual(C.exportTitle({ headers: { get: () => 'attachment; filename="Plain title.txt"' } }), 'Plain title');
  // an old content script answers for the main document: the panel's own export is used instead
  od = await T.executeTool({ id: 'x3', function: { name: 'open_document', arguments: JSON.stringify({ url: OLD_ID }) } }, 'manual', os2);
  assert.ok(od.content.startsWith('Opened as doc4. Title: "Notes ü". 7 lines'));
  deq(exportCalls, [`https://docs.google.com/document/d/${OLD_ID}/export?format=md&authuser=1`]);
  deq(os2.docs.map((d) => [d.alias, d.title, d.lines]), [['doc2', 'Reference paper', 5], ['doc3', 'Notes ü', 7], ['doc4', 'Notes ü', 7]]);
  // the prompt of the NEXT turn lists the opened documents (this turn's prompt keeps the list from its start)
  const head2 = T.buildTurnContext('manual', os2); // feat/context: the list is in the turn context
  assert.ok(head2.includes('no need to open them again): doc2 "Reference paper" (5 lines).]') && !head2.includes('doc3 "Notes'));
});

test('opened documents: kept per chat across a reload, read lazily once per turn, listed in the next prompt', async () => {
  // --- reload keeps the list; content is read again lazily, once per turn; the prompt lists the documents
  state.googleConnected = true;
  sandbox.fetch = docsRouter(exportFetch);
  const chatBeforeReload = state.chatId;
  state.chats = []; // forget everything in memory
  await T.refreshContext({ force: true });
  assert.strictEqual(state.chatId, chatBeforeReload);
  deq(C.chatDocs(state.chatId).map((d) => d.alias), ['doc2', 'doc3', 'doc4']);
  state.docModel = (await D.fetchDocModel('DOC123', 't.0')); state.docText = state.docModel.text; state.docFormat = 'docs-api';
  os3 = T.takeSnapshot(); T.snapshotDocument(os3);
  const head3 = T.buildTurnContext('edit', os3); // feat/context: the list is in the turn context
  assert.ok(head3.includes('</document>\n[Documents opened in this chat with open_document (read them with doc: "<alias>"; no need to open them again): doc2 "Reference paper" (5 lines); doc3 "Notes ü" (7 lines); doc4 "Notes ü" (7 lines).]'));
  const gets = fake2.log.length;
  assert.strictEqual((await T.executeTool({ id: 'y1', function: { name: 'read_lines', arguments: '{"start":5,"end":5,"doc":"doc2"}' } }, 'edit', os3)).content, 'Lines 5-5 of 5:\n5: Rafts move fast.');
  await T.executeTool({ id: 'y2', function: { name: 'get_outline', arguments: '{"doc":"doc2"}' } }, 'edit', os3);
  assert.strictEqual(fake2.log.length, gets + 1); // lazily, once in this turn
  // the Munin persona turn has no client tools and does not list the opened documents
  const os3m = { ...os3, prov: PROVIDERS.munin };
  deq(T.toolsFor('research', os3m), []);
  assert.ok(!T.buildRequest('research', os3m).body.messages[0].content.includes('Documents opened in this chat'));
});

test('open_document confirmation: Allow, Deny, Allow all in this turn, user-named documents, trusted authuser', async () => {
  // --- the confirmation gate of open_document: Allow, Deny, Allow all in this turn, user-named documents
  os3.chatCtx = { docId: 'DOC123', chatId: state.chatId, messages: [{ role: 'user', content: 'Summarize the related work.' }] };
  const openCall = (id, url) => T.executeTool({ id, function: { name: 'open_document', arguments: JSON.stringify({ url }) } }, 'edit', os3, {});
  const GATE1 = 'GATE1aaaaaaaaaaaaaaaaaaaaaaa';
  let gp = openCall('g1', `https://docs.google.com/document/d/${GATE1}/edit`);
  await waitFor(() => T.pendingPreviews.size === 1, 'the open preview');
  let gcard = pending()[0].card;
  assert.ok(gcard.innerHTML.startsWith(`<div class="pv-head">📂 <span class="pv-tool">open_document</span> · Open document ${GATE1}?</div><div class="pv-body">` +
    `<div class="pv-anchor">The assistant wants to read this document and send its text to the AI provider:</div><div class="pv-line">https://docs.google.com/document/d/${GATE1}/edit</div></div>`));
  assert.ok(gcard.innerHTML.includes('>Allow</button>') && gcard.innerHTML.includes('>Deny</button>') && gcard.innerHTML.includes('>Allow all in this turn</button>'));
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(!tabCalls.some((c) => c.docId === GATE1) && !fake.log.some((x) => x.url.includes(GATE1))); // nothing fetched before the decision
  T.decidePreview(pending()[0].id, 'accept');
  let gr = await gp;
  assert.ok(gr._ok && gr.content.startsWith('Opened as doc5. Title: "Gate doc".') && gr._decision === 'accepted');
  const GATE2 = 'GATE2bbbbbbbbbbbbbbbbbbbbbbb';
  gp = openCall('g2', GATE2);
  await waitFor(() => T.pendingPreviews.size === 1, 'the second open preview');
  const fetchedBeforeDeny = tabCalls.length;
  T.decidePreview(pending()[0].id, 'reject');
  gr = await gp;
  deq([gr.content, gr._ok, gr._decision], ['The user did not allow opening this document. Do not retry.', false, 'rejected']);
  assert.strictEqual(tabCalls.length, fetchedBeforeDeny); // not fetched
  assert.ok(!os3.docs.some((d) => d.id === GATE2));
  deq(T.actionLogFromToolCalls([{ id: 'g2', function: { name: 'open_document', arguments: JSON.stringify({ url: GATE2 }) } }], new Map([['g2', gr]]))[0].status, 'rejected');
  const GATE3 = 'GATE3ccccccccccccccccccccccc'; const GATE4 = 'GATE4ddddddddddddddddddddddd';
  gp = openCall('g3', GATE3);
  await waitFor(() => T.pendingPreviews.size === 1, 'the third open preview');
  T.decidePreview(pending()[0].id, 'accept-all');
  assert.ok((await gp).content.startsWith('Opened as doc6.'));
  gr = await openCall('g4', GATE4); // allowed for the rest of the turn: no preview
  assert.strictEqual(T.pendingPreviews.size, 0);
  assert.ok(gr.content.startsWith('Opened as doc7.') && gr._decision === 'accepted-all');
  // a new turn asks again; a document named in the document instructions opens without asking
  let os4 = T.takeSnapshot(); T.snapshotDocument(os4);
  os4.chatCtx = { docId: 'DOC123', chatId: state.chatId, messages: [] };
  const GATE5 = 'GATE5eeeeeeeeeeeeeeeeeeeeeee';
  os4.docInstructions = `Style guide: ${GATE5}`;
  gr = await T.executeTool({ id: 'g5', function: { name: 'open_document', arguments: JSON.stringify({ url: GATE5 }) } }, 'edit', os4, {});
  assert.strictEqual(T.pendingPreviews.size, 0); assert.ok(gr.content.startsWith('Opened as doc8.'));
  const GATE6 = 'GATE6fffffffffffffffffffffff';
  gp = T.executeTool({ id: 'g6', function: { name: 'open_document', arguments: JSON.stringify({ url: GATE6 }) } }, 'edit', os4, {});
  await waitFor(() => T.pendingPreviews.size === 1, 'the preview of the next turn');
  T.decidePreview(pending()[0].id, 'reject');
  assert.strictEqual((await gp)._decision, 'rejected');
  // a "/u/N/" index the user never gave is not trusted: the main document's account is used
  const GATE7 = 'GATE7ggggggggggggggggggggggg';
  os4.mainUrl = 'https://docs.google.com/document/u/1/d/DOC123/edit';
  tabCalls.length = 0;
  gp = T.executeTool({ id: 'g7', function: { name: 'open_document', arguments: JSON.stringify({ url: `https://docs.google.com/document/u/2/d/${GATE7}/edit` }) } }, 'edit', os4, {});
  await waitFor(() => T.pendingPreviews.size === 1, 'the /u/2/ preview');
  assert.ok(!pending()[0].card.innerHTML.includes('Google account index')); // the index used is the main document's
  T.decidePreview(pending()[0].id, 'accept');
  assert.ok((await gp)._ok);
  deq(tabCalls, [{ docId: GATE7, authuser: '1' }]);
  assert.strictEqual(os4.docs.find((d) => d.id === GATE7).authuser, undefined);
  // the same index from the user's own link is used
  const GATE8 = 'GATE8hhhhhhhhhhhhhhhhhhhhhhh';
  os4.chatCtx.messages.push({ role: 'user', content: `See https://docs.google.com/document/u/2/d/${GATE8}/edit please` });
  tabCalls.length = 0;
  assert.ok((await T.executeTool({ id: 'g8', function: { name: 'open_document', arguments: JSON.stringify({ url: `https://docs.google.com/document/u/2/d/${GATE8}/edit` }) } }, 'edit', os4, {}))._ok);
  deq(tabCalls, [{ docId: GATE8, authuser: '2' }]);
  // the card shows a differing index (a document named only by id, with the index from the user's link elsewhere)
  assert.ok(T.previewBodyHtml({ kind: 'open', url: 'u', authuser: '2', mainAuthuser: '1' }).endsWith('<div class="pv-anchor">Google account index 2 (the main document uses 1)</div>'));
});

test('lazy re-read of an opened document: unreadable now (error), grown (line count updated)', async () => {
  // --- an opened document that became unreadable: the lazy re-read reports the error
  let os5 = T.takeSnapshot(); T.snapshotDocument(os5);
  unreadable.add(REF_ID);
  fake2.failNext = { status: 404, message: 'Requested entity was not found.' };
  const rr = await T.executeTool({ id: 'u1', function: { name: 'read_lines', arguments: '{"start":1,"end":2,"doc":"doc2"}' } }, 'edit', os5);
  assert.ok(!rr._ok);
  assert.strictEqual(rr.content, `Error: could not open the document ${REF_ID} (Google Docs API: The Docs API cannot find this document (HTTP 404): the connected Google account probably has no access to it (is it the account you use in this tab?). ` +
    'export: Export returned HTML (no access or sign-in required); export returned HTML (no access)). The user may have no access to it with the Google account of this tab, or the link is wrong.');
  unreadable.delete(REF_ID);
  // a document that grew: the stored line count follows the re-read (the next prompt is current)
  fake2.typeParagraph(5, 'Added later.');
  let os6 = T.takeSnapshot(); T.snapshotDocument(os6); os6.chatCtx = { docId: 'DOC123', chatId: state.chatId, messages: [] };
  await T.executeTool({ id: 'u2', function: { name: 'get_outline', arguments: '{"doc":"doc2"}' } }, 'edit', os6);
  assert.strictEqual(os6.docs.find((d) => d.alias === 'doc2').lines, 6);
  assert.strictEqual(storage['muninChats:DOC123'].find((c) => c.id === state.chatId).docs.find((d) => d.alias === 'doc2').lines, 6);
});
