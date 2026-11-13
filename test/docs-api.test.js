'use strict';
// Google Docs API: the line model, the Docs API prompt and tool set, token handling and errors, Sign in /
// Sign out, full turns with the API, the export fallback.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { chatCards, deq, load, installDocTab, installIdentity, turnRowTexts } = require('./lib/sandbox');
const { sseResponse, ev, tu, msgStart, stopTool } = require('./lib/streams');
const { fakeDocsServer, OC, docSpec, ORIGINAL, WRITE_SET, docsBench } = require('./lib/fake-docs');

let fake; let as; // the fake Docs server and the turn snapshot; fresh() replaces both
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, D, state, sandbox, storage, chrome, ident, routeDocs, fresh, model, tabMsgs2, apiRounds, apiBodies;

before(async () => {
  env = await load();
  T = D = env.T;
  state = env.state;
  sandbox = env.ctx;
  storage = env.storage;
  chrome = env.chrome;
  ident = installIdentity(env);
  ({ routeDocs, fresh } = docsBench(env, ident, ref));
  // storage and the Docs tab as the earlier checks of the old harness left them
  Object.assign(storage, { muninProvider: 'anthropic', anthropicApiKey: 'sk-ant-NEW', anthropicModel: 'claude-sonnet-5-5', muninApiKey: 'sk-munin-NEW' });
  await T.loadSettings();
  installDocTab(env);
  await T.refreshContext({ force: true });
});

test('Docs API line model: indices, emoji, tables, objects, tabs', async () => {
  fake = fakeDocsServer(docSpec());
  sandbox.fetch = routeDocs();
  ident.granted = true;
  state.googleConnected = true;

  // --- line model: indices written out by hand (UTF-16: the emoji takes 2), headings, tables, objects, tabs; the table
  // ends one index after its last cell (88), as in Docs
  model = await D.fetchDocModel('DOC123', null);
  assert.strictEqual(fake.log[0].url, 'https://docs.googleapis.com/v1/documents/DOC123?includeTabsContent=true&fields=' + T.DOCS_GET_FIELDS);
  assert.strictEqual(fake.log[0].auth, 'Bearer tok-1');
  deq(model.lines.map((l) => [l.line, l.start, l.end, l.text, l.heading]), [
    [1, 1, 10, 'Report 📊', 1], [2, 11, 25, 'Intro 😀 text.', 0], [3, 26, 33, 'Methods', 1], [4, 34, 51, 'Alpha beta gamma.', 0],
    [5, 52, 69, 'Alpha beta delta.', 0], [6, 73, 79, 'Cell A', 0], [7, 81, 87, 'Cell B', 0], [8, 89, 96, 'Details', 2],
    [9, 97, 109, 'Image ' + OC + ' done', 0], [10, 110, 119, 'Last line', 0],
  ]);
  assert.strictEqual(D.lineAtIndex(model, 88), null);
  assert.ok(model.lines.every((l) => l.exact && !l.suggested));
  deq(model.lines.map((l) => !!l.closing), [false, false, false, false, true, true, true, false, false, true]);
  assert.strictEqual(model.text, ORIGINAL.join('\n'));
  assert.strictEqual(model.tabId, 't.0'); assert.strictEqual(model.tabCount, 2); assert.strictEqual(model.revisionId, 'rev-1');
  assert.strictEqual(D.textAtIndexRange(model, 17, 25), '😀 text.'); // 'Intro ' = 11..16, the emoji takes 17 and 18
  assert.strictEqual(D.textAtIndexRange(model, 26, 41), 'Methods\nAlpha b');
  assert.strictEqual(D.textAtIndexRange(model, 69, 74), null); // crosses the table start
  assert.strictEqual(D.lineAtIndex(model, 70), null); assert.strictEqual(D.lineAtIndex(model, 87).line, 7);
  const r1 = D.indexRange(model, 16, 18); // the emoji: text offsets 16-17 (line 2 starts at offset 10)
  deq([r1.start, r1.end, r1.from, r1.to], [17, 19, 2, 2]);
  assert.ok(/crosses the end of line 5/.test(D.indexRange(model, 62, 72).error));
  assert.strictEqual(D.docsTabFromUrl('https://docs.google.com/document/d/DOC123/edit?tab=t.second#heading=h.1'), 't.second');
  const m2 = await D.fetchDocModel('DOC123', 't.second');
  deq(m2.lines.map((l) => [l.start, l.end, l.text]), [[1, 11, 'Second tab'], [12, 21, 'Note text']]); assert.strictEqual(m2.tabId, 't.second');
  // a tab that no longer exists: an error for re-reads/undo, the first tab for the URL's tab
  await assert.rejects(() => D.fetchDocModel('DOC123', 't.gone'), /Docs tab "t\.gone" of this document no longer exists/);
  assert.strictEqual((await D.fetchDocModel('DOC123', 't.gone', false)).tabId, 't.0');
});

test('Docs API outline, prompt, tool set, parallel tool use off', async () => {
  // --- outline from the paragraph styles; prompt in tools mode; tools offered; parallel tool use off
  state.settings.provider = 'anthropic';
  state.docId = 'DOC123';
  state.docModel = model; state.docText = model.text; state.docFormat = 'docs-api'; state.docTitle = 'My Doc'; state.docError = ''; state.selection = '';
  let as = T.takeSnapshot(); T.snapshotDocument(as);
  deq(T.docOutline(as).map((h) => [h.line, h.level, h.title]), [[1, 1, 'Report 📊'], [3, 1, 'Methods'], [8, 2, 'Details']]);
  assert.strictEqual(D.formatOutline(T.docOutline(as)), 'L1: [Title] Report 📊\nL3: [H1] Methods\nL8: [H2] Details');
  assert.ok(/^3 headings \(10 lines in total\):\nL1: \[Title\]/.test(T.runReadingTool('get_outline', {}, as)));
  deq(T.toolsFor('edit', as).map((t) => t.function.name), ['read_document', 'find_in_document', 'get_selection', 'open_document', 'remember', ...WRITE_SET, 'replace_selection', 'ask_user', 'table', 'page_parts', 'document_styles', 'style_map', 'draft', 'revise_section', 'trim_to_words', 'phrase_usage', 'models', 'search', 'delegate']);
  deq(T.toolsFor('manual', as).map((t) => t.function.name), ['read_document', 'find_in_document', 'get_selection', 'open_document', 'remember', 'ask_user', 'page_parts', 'document_styles', 'style_map', 'phrase_usage', 'models', 'search', 'delegate']);
  deq(T.toolsFor('research', as).map((t) => t.function.name), ['read_document', 'find_in_document', 'get_selection', 'open_document', 'remember', 'ask_user', 'page_parts', 'document_styles', 'style_map', 'models', 'search', 'delegate']);
  let areq = T.buildRequest('edit', as);
  const sys0 = areq.body.system[0].text;
  const ctx0 = T.buildTurnContext('edit', as); // feat/context: the outline is in the turn context of the user message
  assert.ok(ctx0.includes('<document title="My Doc" tab="Main" format="docs-api" lines="10" characters="'));
  assert.ok(ctx0.includes('Outline (line: heading):\nL1: [Title] Report 📊\nL3: [H1] Methods\nL8: [H2] Details'));
  assert.ok(sys0.includes('read through the Google Docs API as plain text') && sys0.includes('with the writing tools.') && sys0.includes('ONE edit_document call') && sys0.includes('Otherwise one edit call per response'));
  assert.ok(!sys0.includes('replace_text(old_text, new_text)') && sys0.includes('Use replace_all for terminology or notation changes across the document, once find_in_document shows')); // the definitions describe the tools
  assert.ok(sys0.includes('8. When every edit succeeded, add nothing: the edit cards already show what changed.'));
  // Next to the filtering search (web_search_20260209 runs code execution) the API refuses disable_parallel_tool_use: no
  // tool_choice, and the loop runs one edit per response (runRoundCalls); without the search the edits go one at a time.
  assert.strictEqual(areq.body.tools[areq.body.tools.length - 1].type, 'web_search_20260209');
  assert.strictEqual(areq.body.tool_choice, undefined);
  deq(T.buildRequest('edit', { ...as, quiet: true }).body.tool_choice, { type: 'auto', disable_parallel_tool_use: true });
  // the fixed strict set strict (every property required: request.js ANTHROPIC_STRICT_TOOLS); every other tool compact
  // and without the strict field, edit_document among them (test/anthropic-strict.test.js counts the API's limits)
  areq.body.tools.filter((t) => t.input_schema && T.ANTHROPIC_STRICT_TOOLS.includes(t.name)).forEach((t) => { assert.strictEqual(t.strict, true); deq(Object.keys(t.input_schema.properties).sort(), [...t.input_schema.required].sort()); });
  const ed = areq.body.tools.find((t) => t.name === 'edit_document');
  assert.strictEqual(ed.strict, undefined);
  deq(ed.input_schema, T.compactSchema(T.TOOL_DEFS.edit_document.function.parameters));
  assert.strictEqual(T.buildRequest('manual', as).body.tool_choice, undefined); // no write tools, parallel calls allowed
  state.settings.provider = 'openai';
  let oas = T.takeSnapshot(); T.snapshotDocument(oas);
  assert.strictEqual(T.buildRequest('edit', oas).body.parallel_tool_calls, false);
  assert.strictEqual(T.buildRequest('manual', oas).body.parallel_tool_calls, undefined);
  state.settings.provider = 'munin';
  let mas = T.takeSnapshot(); T.snapshotDocument(mas);
  assert.strictEqual(T.buildRequest('edit', mas).body.parallel_tool_calls, false);
  assert.strictEqual(T.buildRequest('manual', mas).body.parallel_tool_calls, undefined);
  state.settings.provider = 'anthropic';
});

test('Docs API: 401 retry, readable errors, no token', async () => {
  // --- 401 retry, readable errors, no token
  await fresh();
  fake.token = ident.token = 'tok-2'; // the stored tok-1 is refused; the silent renewal yields tok-2
  ident.calls.length = 0;
  const m401 = await D.fetchDocModel('DOC123', 't.0');
  deq(ident.calls, [false]); assert.strictEqual(m401.lines.length, 10);
  deq(fake.log.slice(-2).map((x) => x.auth), ['Bearer tok-1', 'Bearer tok-2']);
  ident.token = 'tok-1'; fake.token = 'tok-1'; ident.forget();
  fake.failNext = { status: 403, message: 'Google Docs API has not been used in project 123' };
  await assert.rejects(() => D.fetchDocModel('DOC123', null), (e) => /HTTP 403/.test(e.message) && /not been used/.test(e.message));
  await assert.rejects(() => D.fetchDocModel('OTHER', null), /HTTP 404.*no access/);
  fake.failNext = { status: 429 };
  await assert.rejects(() => D.fetchDocModel('DOC123', null), /HTTP 429/);
  ident.granted = false; ident.forget();
  await assert.rejects(() => D.fetchDocModel('DOC123', null), (e) => /not signed in or the authorization expired/.test(e.message) && e.preSend === true);
  ident.granted = true;
});

test('settings: Google account Sign in / Sign out', async () => {
  state.googleConnected = false; state.googleAccount = null;
  storage.muninGoogleConnected = undefined;
  T.openSettings();
  const shown = (e) => !e.classList.contains('hidden');
  assert.strictEqual(T.el.googleStatus.dataset.tip, 'Not signed in');
  assert.ok(shown(T.el.googleConnect) && !shown(T.el.googleSwitch) && !shown(T.el.googleDisconnect));
  ident.granted = false; ident.calls.length = 0; ident.forget();
  ident.failInteractive = 'The user did not approve access.';
  assert.strictEqual(await D.connectGoogle(), false);
  assert.ok(/Could not sign in: The user did not approve access/.test(T.el.googleHint.textContent));
  assert.strictEqual(state.googleConnected, false);
  ident.failInteractive = null;
  const userinfo = [];
  sandbox.fetch = routeDocs(async (url, init) => { userinfo.push([url, init.headers.Authorization]); return { ok: true, status: 200, json: async () => ({ email: 'ann@example.com' }) }; });
  assert.strictEqual(await D.connectGoogle(), true);
  deq(ident.calls, [true, true]);
  deq(ident.requests[1].scope.split(' '), ['https://www.googleapis.com/auth/documents', 'openid', 'email', 'profile']);
  deq(userinfo, [['https://openidconnect.googleapis.com/v1/userinfo', 'Bearer tok-1']]);
  assert.strictEqual(state.googleConnected, true); assert.strictEqual(storage.muninGoogleConnected, true);
  assert.strictEqual(T.el.googleStatus.dataset.tip, 'Signed in as ann@example.com');
  assert.strictEqual(T.el.googleHint.textContent, 'Signed in as ann@example.com.'); // the settings say it, not the chat
  assert.ok(!shown(T.el.googleConnect) && shown(T.el.googleSwitch) && shown(T.el.googleDisconnect));
  await T.loadSettings(); assert.strictEqual(state.googleConnected, true); deq(state.googleAccount, { email: 'ann@example.com' }); // remembered
  const revoked = [];
  sandbox.fetch = routeDocs(async (url, init) => { revoked.push([url, init.body, init.mode]); return { ok: true, status: 200 }; });
  await D.disconnectGoogle();
  deq(revoked, [['https://oauth2.googleapis.com/revoke', 'token=tok-1', 'no-cors']]);
  assert.strictEqual(state.googleConnected, false); assert.strictEqual(storage.muninGoogleConnected, false); assert.strictEqual(state.docModel, null);
  assert.strictEqual(state.googleAccount, null); assert.ok(!('muninGoogleAccount' in storage));
  assert.strictEqual(T.el.googleStatus.dataset.tip, 'Not signed in');
  assert.ok(!T.el.chat.children.some((c) => /Signed (out|in)/.test(c.innerHTML || c._text || ''))); // nothing in the chat
  assert.strictEqual(T.el.googleHint.textContent, '');
  T.el.settings.classList.add('hidden');
});

test('end-to-end turn with the Docs API (Anthropic): the second edit of a response waits, Undo button', async () => {
  // --- end-to-end turn (Anthropic): read, then two edits in ONE response (the second is not run: it waits for the
  //     next response), final sentence; Undo button; sendMessage blocked while an undo runs
  fake = fakeDocsServer(docSpec());
  tabMsgs2 = [];
  chrome.tabs.sendMessage = async (id, msg) => {
    tabMsgs2.push(msg.type);
    switch (msg.type) {
      case 'PING': return { ok: true, title: 'My Doc' };
      case 'GET_SELECTION': return { ok: true, text: '' };
      case 'GET_DOC_TEXT': return { ok: true, text: '# Exported\n\nexport text\n', format: 'markdown', title: 'My Doc' };
      default: return { ok: true };
    }
  };
  await D.createChat();
  deq(state.messages, []);
  ident.granted = true; state.googleConnected = true;
  state.applyMode = 'auto';
  state.settings.provider = 'anthropic';
  apiRounds = [
    msgStart + tu(0, 'toolu_r', 'read_document', { scope: { start: 4, end: 5 }, include: ['text'], doc: null }) + stopTool,
    msgStart + tu(0, 'toolu_w', 'replace_text', { old_text: 'beta gamma', new_text: 'beta GAMMA' }) + tu(1, 'toolu_d', 'delete_lines', { start: 5, end: 5 }) + stopTool,
    msgStart + ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Capitalized "gamma" in line 4.' } }) +
      ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }) + ev('message_stop', { type: 'message_stop' }),
  ];
  apiBodies = [];
  sandbox.fetch = routeDocs(async (url, init) => { assert.strictEqual(url, 'https://api.anthropic.com/v1/messages'); apiBodies.push(JSON.parse(init.body)); return sseResponse(apiRounds[apiBodies.length - 1]); });
  T.el.input.value = 'Capitalize gamma';
  await T.sendMessage();
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(apiBodies.length, 3);
  assert.ok(!tabMsgs2.includes('GET_DOC_TEXT')); // no export when the API works
  assert.strictEqual(state.docFormat, 'docs-api');
  deq(apiBodies[0].tools.map((t) => t.name), ['read_document', 'find_in_document', 'get_selection', 'open_document', 'remember', ...WRITE_SET, 'replace_selection', 'ask_user', 'table', 'page_parts', 'document_styles', 'style_map', 'draft', 'revise_section', 'trim_to_words', 'phrase_usage', 'chat_title', 'models', 'search', 'delegate', 'web_search']);
  assert.strictEqual(apiBodies[0].tool_choice, undefined); // next to the filtering search: one edit per response is the loop's
  assert.ok(apiBodies[0].messages[0].content[0].text.includes('L3: [H1] Methods')); // feat/context: in the user message
  deq(apiBodies[1].messages[2].content, [{ type: 'tool_result', tool_use_id: 'toolu_r', content: 'Lines 4-5 of 10:\n4: Alpha beta gamma.\n5: Alpha beta delta.', cache_control: { type: 'ephemeral' } }]);
  const results2 = apiBodies[2].messages[4].content;
  assert.strictEqual(results2[0].tool_use_id, 'toolu_w');
  assert.strictEqual(results2[0].content, 'Done: replaced line 4; the document has 10 lines.'); // no section note (src/prose-tools.js): no sentence of 5+ words to quote
  assert.strictEqual(results2[1].tool_use_id, 'toolu_d'); assert.strictEqual(results2[1].is_error, true);
  assert.strictEqual(results2[1].content, T.ONE_EDIT_TEXT); // both results in the one user message after the response
  assert.strictEqual(T.ONE_EDIT_TEXT, 'Not run: only one edit runs per response (an edit can shift line numbers). Send this call again in your next response, with current line numbers if it uses any.');
  deq(apiBodies[2].system, apiBodies[0].system); // the prompt stays frozen for the turn
  assert.ok(fake.text('t.0').includes('Alpha beta GAMMA.') && fake.text('t.0').includes('Alpha beta delta.'));
  assert.ok(state.docText.includes('Alpha beta GAMMA.'));
  let hist = state.messages;
  assert.strictEqual(hist.length, 7);
  assert.strictEqual(hist[4]._edit.id, 'toolu_w'); assert.strictEqual(hist[4]._message, 'Replaced line 4');
  assert.strictEqual(hist[5]._ok, false); assert.strictEqual(hist[5]._deferred, true);
  assert.strictEqual(hist[6].content, 'Capitalized "gamma" in line 4.');
  deq(JSON.parse(JSON.stringify(storage['muninChatHistory:DOC123:' + state.chatId]))[4]._edit.restore, 'gamma'); // the journal is persisted (only the changed word: prefix/suffix trimming)
  T.el.chat.children.length = 0; // the stub's innerHTML = '' does not drop children
  D.renderHistory();
  // the applied edit is its action-log row (status, preview, Undo, What changed in the fold); the one that waited has no
  // row and no card (the model sends it again, and that call has the row)
  const writeRows = () => T.el.chat.children.flatMap((c) => c._rows || []).filter((r) => r.className.includes('write-row'));
  assert.strictEqual(chatCards(T.el.chat).length, 0);
  assert.strictEqual(T.el.chat.children.filter((c) => c.className.includes('tool-card')).length, 0);
  const failed = T.el.chat.children.flatMap((c) => c._rows || []).filter((r) => /\blog-row fail\b/.test(r.className));
  assert.strictEqual(failed.length, 0);
  assert.ok(!T.el.chat.children.flatMap((c) => c._rows || []).some((r) => r.innerHTML.includes('<span class="activity-name">delete_lines</span>')));
  const row = writeRows()[0];
  assert.ok(row.innerHTML.includes('<span class="activity-name">replace_text</span> · <span class="log-status">Done</span><span class="log-preview"> · beta GAMMA</span>'), row.innerHTML);
  assert.ok(row.innerHTML.includes('data-act="undo-edit" data-edit="toolu_w"') && row.innerHTML.includes('<div class="log-what">Replaced line 4</div>') && row.innerHTML.includes('<div class="log-label">What changed</div><div class="word-diff">beta <del>gamma</del><ins>GAMMA</ins></div>'));
  // sendMessage waits while an undo is running
  state.undoing = true;
  const before = apiBodies.length;
  T.el.input.value = 'Hello';
  await T.sendMessage();
  assert.strictEqual(apiBodies.length, before); assert.strictEqual(T.el.input.value, 'Hello');
  state.undoing = false; T.el.input.value = '';
  assert.strictEqual(await D.undoFromButton('toolu_w'), true);
  assert.ok(fake.text('t.0').includes('Alpha beta gamma.'));
  assert.ok(state.docText.includes('Alpha beta gamma.'));
  assert.strictEqual(state.messages[4]._edit.undone, true);
  assert.ok(/user undid this edit/.test(state.messages[4].content));
  const rowEl = writeRows().pop();
  assert.ok(rowEl.className.includes('undone') && rowEl.innerHTML.includes('<span class="log-status">Undone</span>') && !rowEl.innerHTML.includes('undo-edit'));
  assert.strictEqual(await D.undoFromButton('toolu_w'), false); // already undone
});

test('Docs API failure falls back to the export (with a row of the turn)', async () => {
  // --- connected but the API fails: one row of the turn, export fallback, no writing tools
  fake.failNext = { status: 403, message: 'The caller does not have permission' };
  apiBodies.length = 0;
  const finalOnly = apiRounds[2];
  sandbox.fetch = routeDocs(async (url, init) => { apiBodies.push(JSON.parse(init.body)); return sseResponse(finalOnly); });
  tabMsgs2.length = 0;
  T.el.chat.children.length = 0;
  T.el.input.value = 'Anything';
  await T.sendMessage();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(tabMsgs2.includes('GET_DOC_TEXT')); assert.strictEqual(state.docFormat, 'markdown'); assert.strictEqual(state.docModel, null);
  assert.ok(turnRowTexts(T.el.chat).some((t) => /^Could not read the document through the Google Docs API: Google denied access \(HTTP 403\)/.test(t)));
  assert.ok(/^Could not read the document through the Google Docs API/.test(state.messages.find((m) => m.content === 'Anything')._notes[0])); // stored with the turn
  deq(apiBodies[0].tools.map((t) => t.name), ['read_document', 'find_in_document', 'get_selection', 'open_document', 'remember', 'replace_selection', 'ask_user', 'phrase_usage', 'chat_title', 'models', 'search', 'delegate', 'web_search']);
  assert.strictEqual(apiBodies[0].tool_choice, undefined);
});

test('not connected: export path and the old tools', async () => {
  // --- not connected: the export path and today's tools
  state.googleConnected = false;
  apiBodies.length = 0; tabMsgs2.length = 0;
  const getsBefore = fake.log.length;
  T.el.input.value = 'Anything else';
  await T.sendMessage();
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(fake.log.length, getsBefore); // the Docs API is not called
  assert.ok(tabMsgs2.includes('GET_DOC_TEXT')); assert.strictEqual(state.docFormat, 'markdown');
  deq(apiBodies[0].tools.map((t) => t.name), ['read_document', 'find_in_document', 'get_selection', 'open_document', 'remember', 'replace_selection', 'ask_user', 'phrase_usage', 'chat_title', 'models', 'search', 'delegate', 'web_search']);
  assert.ok(apiBodies[0].system[0].text.includes('Call replace_selection at most once per request'));
});

test('HTTP 403 of the Docs API: advice by cause (scope, API not enabled, no access to the document)', async () => {
  await fresh();
  const cases = [
    ['Request had insufficient authentication scopes.', /lacks access to Google Docs \(the documents scope\)\. .*click Sign out, then Sign in with Google/],
    ['Google Docs API has not been used in project 123 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/docs.googleapis.com/overview?project=123 then retry.',
      /the Google Docs API is not enabled in the Google Cloud project of the OAuth client\. .*Google: Google Docs API has not been used in project 123/],
    ['The caller does not have permission', /the connected Google account has no access to this document/],
    ['Something else', /may not be enabled in your Google Cloud project, the consent may lack the documents scope/],
  ];
  for (const [message, re] of cases) {
    fake.failNext = { status: 403, message };
    await assert.rejects(() => D.fetchDocModel('DOC123', null), (e) => e.status === 403 && /^Google denied access \(HTTP 403\): /.test(e.message) && re.test(e.message));
  }
  // the reason in the error details decides too
  sandbox.fetch = async () => ({ ok: false, status: 403, text: async () => JSON.stringify({ error: { code: 403, message: 'Forbidden', status: 'PERMISSION_DENIED', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } }) });
  await assert.rejects(() => D.fetchDocModel('DOC123', null), /lacks access to Google Docs \(the documents scope\)/);
  sandbox.fetch = async () => ({ ok: false, status: 403, text: async () => JSON.stringify({ error: { code: 403, message: 'Forbidden', status: 'PERMISSION_DENIED', details: [{ reason: 'SERVICE_DISABLED' }] } }) });
  await assert.rejects(() => D.fetchDocModel('DOC123', null), /not enabled in the Google Cloud project/);
});
