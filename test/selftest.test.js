'use strict';
// The built-in self-test (/test): parsing, the checks against the fake Docs API, the stub content-script tab and
// fake provider streams, the Environment row, the "Empty document" gate (a document with text: the harmless
// checks only), the report card, the write cycle on an empty document (no confirmation card) and Stop. The
// model scenarios are in selftest-model.test.js.
const { test } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, installIdentity } = require('./lib/sandbox');
const { sseResponse, textRound } = require('./lib/streams');
const { fakeDocsServer, docSpec, ORIGINAL } = require('./lib/fake-docs');
require('./lib/fake-tables'); // the requests of the Write: table row
const { webLocks } = require('./lib/shared-storage');
const { SIGNAL_STATE } = require('./lib/selftest-bench');

// The Markdown export of docSpec() as the content script would return it.
const EXPORT_MD = '# Report 📊\n\nIntro 😀 text.\n\n# Methods\n\nAlpha beta gamma.\n\nAlpha beta delta.\n\n| Cell A | Cell B |\n| :---- | :---- |\n\n## Details\n\nImage ![][image1] done\n\nLast line\n';
const json = (obj, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => obj, text: async () => JSON.stringify(obj), headers: { get: () => '' } });

// A panel on document DOC123 (tab 7) with the fake Docs API, a stub content script and an Anthropic key.
// opts: connected (Google), exportFail (download disabled: the tab and the panel export fail), reply (the
// probe completion's text), onModels (called when GET /models arrives), account (the signed-in Google account
// when connected), selection (the document's selection), empty (an empty document: the fake Docs API and the export have no text; nothing selected).
// Any permission card is recorded in b.cards and denied (the self-test has none); the Your-turn cards are
// skipped (b.turns logs them; test/selftest-interactive.test.js answers them).
async function bench({ connected = true, exportFail = false, reply = 'OK', onModels = null, account = { email: 'ann@example.com' }, selection = 'Alpha beta gamma.', empty = false } = {}) {
  const env = await load();
  const { T, state, chrome, ctx } = env;
  const ident = installIdentity(env);
  chrome.runtime.getManifest = () => ({ version: '9.9.9' });
  ident.granted = true;
  installDocTab(env);
  ctx.navigator.locks = webLocks();
  ctx.navigator.userAgent = 'Mozilla/5.0 Chrome/140.0.1234.5 Safari/537.36';
  const fake = fakeDocsServer(empty ? docSpec({ items: [{ p: '' }] }) : docSpec());
  const exportText = empty ? '' : EXPORT_MD;
  if (empty) selection = '';
  const tabMsgs = [];
  chrome.tabs.sendMessage = async (id, msg) => {
    tabMsgs.push(msg.type);
    switch (msg.type) {
      case 'PING': return { ok: true, docId: 'DOC123', title: 'My Doc' };
      case 'GET_SIGNAL_STATE': return SIGNAL_STATE;
      case 'GET_SELECTION': return { ok: true, text: selection, cached: true };
      case 'GET_DOC_TEXT': return exportFail ? { ok: false, error: 'download disabled', title: 'My Doc' } : { ok: true, text: exportText, format: 'markdown', title: 'My Doc' };
      default: return { ok: true };
    }
  };
  const bodies = [];
  const urls = [];
  const b = { env, T, state, ctx, fake, tabMsgs, bodies, urls, statuses: [], cards: [], turns: [] };
  ctx.exportSleep = async () => {};
  ctx.fetch = async (url, init = {}) => {
    urls.push(url);
    const r = await b.fake.fetch(url, init);
    if (r) return r;
    if (url.includes('/export?')) return exportFail ? json({ error: 'forbidden' }, 403) : { ok: true, status: 200, text: async () => exportText, headers: { get: () => '' } };
    if (url.includes('/models')) { if (onModels) onModels(b); return json({ data: [{ id: 'claude-haiku-4-5' }, { id: 'claude-opus-5-5' }], has_more: false }); }
    if (url.endsWith('/messages')) { bodies.push(JSON.parse(init.body)); return sseResponse(textRound(reply)); }
    throw new Error('unexpected fetch ' + url);
  };
  state.settings.provider = 'anthropic';
  Object.assign(state.settings.providers.anthropic, { apiKey: 'sk-ant-test', model: 'claude-haiku-4-5' });
  state.googleConnected = connected;
  state.googleAccount = connected ? account : null;
  await T.refreshContext({ force: true });
  const setStatus = ctx.setStatus;
  ctx.setStatus = (text, warn) => { b.statuses.push(text); return setStatus(text, warn); };
  // The self-test's live row in the chat, as each update left it: its text and the orb's mode (data-orb; the stub
  // canvas of the sandbox keeps its attributes here). b.liveOrb: the row's orb.
  b.live = [];
  const orbCreate = ctx.orbCreate;
  ctx.orbCreate = () => {
    const c = orbCreate();
    const attrs = {};
    Object.assign(c, { setAttribute: (k, v) => { attrs[k] = String(v); }, getAttribute: (k) => (k in attrs ? attrs[k] : null), removeAttribute: (k) => { delete attrs[k]; } });
    return c;
  };
  const liveRow = () => T.el.chat.children.find((c) => c && c.classList && c.classList.contains('selftest-live'));
  b.liveRow = liveRow;
  const stLive = ctx.stLive;
  ctx.stLive = (c, text, mode) => {
    stLive(c, text, mode);
    const row = liveRow();
    if (row) b.liveOrb = row._orb;
    b.live.push(row ? `${row._text.textContent} ${row._orb.tagName === 'canvas' ? row._orb.getAttribute('data-orb') : '?'}` : '(no row)');
  };
  b.run = async (command) => {
    T.el.input.value = command;
    const t = setInterval(() => {
      for (const [id, p] of T.pendingPreviews) {
        if (p.yourTurn) { b.turns.push(p.yourTurn); T.decidePreview(id, 'skip'); continue; }
        b.cards.push(p.card.innerHTML); T.decidePreview(id, 'reject');
      }
    }, 2);
    try { await T.sendMessage(); } finally { clearInterval(t); }
    return b.card();
  };
  b.card = () => T.el.chat.children.find((c) => c && c.classList && c.classList.contains('selftest'));
  b.rows = () => b.card()._selfTest.rows;
  b.row = (name) => b.rows().find((r) => r.name === name);
  b.posts = () => b.fake.log.filter((x) => x.method === 'POST').map((x) => x.body);
  return b;
}
const statusOf = (rows) => Object.fromEntries(rows.map((r) => [r.name, r.status]));

test('parseSlashCommand: /test, with anything after it ignored', async () => {
  const { T } = await load();
  deq(T.parseSlashCommand('/test'), { persona: null, selftest: true, text: '' });
  deq(T.parseSlashCommand('  /TEST write please'), { persona: null, selftest: true, text: '' });
  deq(T.parseSlashCommand('/test\nall'), { persona: null, selftest: true, text: '' });
  deq(T.parseSlashCommand('/test model'), { persona: null, selftest: true, text: '' });
  deq(T.parseSlashCommand('/tester'), { persona: null, text: '/tester' });
  deq(T.parseSlashCommand('please /test'), { persona: null, text: 'please /test' });
  deq(Object.keys(T.SELFTEST_COMMANDS), ['test']);
});

const HARMLESS = ['Environment', 'Content script', 'Change signal', 'Selection', 'Export read', 'Docs API read', 'Model list', 'Completion'];
const READING = ['get_outline', 'read_lines', 'find_in_document', 'get_selection', 'read_formatting', 'Matching'];
const EDITS = ['Write: replace_text', 'Write: format_text', 'Write: text styles', 'Write: format_lines', 'Write: lists', 'Write: delete_lines', 'Write: undo_last_edit'];
// The registered Docs API rows (registerSelfTestRows) after "Write: lists".
const API_EDITS = [...EDITS.slice(0, EDITS.indexOf('Write: lists') + 1), 'Write: table', 'Write: page parts', ...EDITS.slice(EDITS.indexOf('Write: lists') + 1)];
const MODEL_ROWS = ['Model: write a section', 'Model: replace a phrase', 'Model: format', 'Model: heading', 'Model: replace all', 'Model: list',
  'Model: selection', 'Model: question', 'Model: delete', 'Model: cleanup'];
const HANDS = ['Your turn: select text', 'Model: replace the selection', 'Your turn: make text bold', 'Your turn: typing signal'];
const API_ROWS = [...HARMLESS, 'Empty document', 'Write: insert_after_line', ...READING, ...HANDS, ...API_EDITS, ...MODEL_ROWS, 'Multi-tab'];
const EXPORT_ROWS = [...HARMLESS, 'Empty document', 'Write: insert_after_line', ...EDITS, 'Model: insert at the cursor', ...READING,
  ...HANDS, 'Model: question', 'Your turn: remove the test text', 'Multi-tab'];
const NOT_EMPTY = `the document is not empty (${ORIGINAL.join('\n').length} characters, 10 lines): open a new, empty Google Doc and run /test there`;

test('/test on a document with text: the harmless checks pass, "Empty document" fails, nothing else runs; the card is not in the history', async () => {
  const b = await bench();
  const { T, state } = b;
  const before = JSON.stringify(state.messages);
  const card = await b.run('/test');
  assert.ok(card, 'the report card is shown');
  const rows = b.rows();
  deq(rows.map((r) => r.name), API_ROWS);
  for (const r of rows) {
    if (r.name === 'Empty document') deq([r.status, r.detail], ['fail', NOT_EMPTY]);
    else if (HARMLESS.includes(r.name) || r.name === 'Multi-tab') assert.strictEqual(r.status, 'pass', `${r.name}: ${r.detail} ${r.more || ''}`);
    else deq([r.status, r.detail], ['skip', `not run: ${NOT_EMPTY}`], r.name);
    assert.ok(Number.isFinite(r.ms));
  }
  deq(b.cards, [], 'no confirmation card');
  deq(b.posts(), [], 'no batchUpdate');
  assert.ok(!b.tabMsgs.includes('REPLACE_SELECTION'));
  assert.strictEqual(b.fake.text('t.0'), ORIGINAL.join('\n'));
  assert.match(b.row('Environment').detail, /v9\.9\.9 · Anthropic \(Claude\) \/ claude-haiku-4-5 · API key set · Google: signed in as ann@example\.com · Mode: (Manual|Edit automatically|Plan) · Web Locks available · Chrome 140/);
  assert.ok(!JSON.stringify(rows).includes('sk-ant-test'), 'the key is never shown');
  assert.match(b.row('Content script').detail, /^PING \d+ ms · document DOC123 · «My Doc»$/);
  assert.strictEqual(b.row('Selection').detail, '17 characters (cached)');
  assert.match(b.row('Export read').detail, /characters · markdown · 19 lines · read by the panel · 1 export request in this self-test$/);
  assert.match(b.row('Docs API read').detail, /revision rev-1 · tab t\.0 of 2 · 10 lines · 3 headings · 0 with suggestions · 1 embedded object · 0 soft breaks/);
  assert.match(b.row('Model list').detail, /2 models/);
  assert.match(b.row('Completion').detail, /claude-haiku-4-5 · reply «OK» · 50 in \/ 3 out tokens/);
  assert.match(b.row('Multi-tab').detail, /no other tab holds this chat/);
  // the probe: one request, the probe message only, no tools, 16 output tokens
  assert.strictEqual(b.bodies.length, 1);
  assert.strictEqual(b.bodies[0].tools, undefined);
  assert.strictEqual(b.bodies[0].max_tokens, 16);
  deq(b.bodies[0].messages, [{ role: 'user', content: [{ type: 'text', text: 'Reply with the single word OK.', cache_control: { type: 'ephemeral' } }] }]);
  // nothing went into the chat history; the card is a notice with one row per check
  assert.strictEqual(JSON.stringify(state.messages), before);
  assert.ok(card.classList.contains('notice'));
  assert.strictEqual(card.innerHTML.split('class="st-row st-').length - 1, rows.length);
  assert.ok(card.innerHTML.includes('data-act="copy-selftest"'));
  assert.ok(card.innerHTML.includes('Send this report to the developer'));
  // the Markdown copy: header, a table with one line per check, the summary
  const md = card._report;
  assert.ok(md.startsWith('## Munin self-test\n'));
  assert.ok(md.includes('- Document: «My Doc» (DOC123) · Docs tab t.0 «Main» · browser tab 7'));
  assert.ok(md.includes('| # | Check | Result | Time | Detail |\n|---|---|---|---|---|\n| 1 | Environment | ✅ pass |'));
  assert.strictEqual(md.split('\n').filter((l) => /^\| \d+ \|/.test(l)).length, rows.length);
  assert.ok(md.includes('**Summary:** 9 passed, 0 warnings, 1 failed, 30 skipped'));
  deq(b.turns, [], 'no Your-turn card on a document with text');
  assert.ok(!md.includes('- Model:'), 'no model line without the model scenarios');
  assert.ok(!Object.keys(b.env.storage).some((k) => k.startsWith('muninSelfTest:')), 'the report is not stored');
  // the progress was in the chat's live row, not in the status line, which is back to the document line
  deq(b.statuses.filter((s) => /self-test/i.test(s)), []);
  deq(b.live[0], 'Self-test running… orbits');
  deq(b.live[1], 'Self-test: 1 of 40 · Environment orbits');
  assert.ok(b.live.includes('Self-test: 40 of 40 · Multi-tab orbits'));
  assert.ok(b.live.every((t) => t.startsWith('Self-test')), 'the live row shows only the progress');
  assert.strictEqual(b.liveRow(), undefined, 'the live row is gone, the report card took its place');
  assert.strictEqual(b.liveOrb.getAttribute('data-orb'), null, 'the orb loop stopped');
  assert.ok(b.liveOrb.classList.contains('hidden'));
  assert.strictEqual(T.el.docStatus.textContent, T.docStatusText());
  assert.strictEqual(state.busy, false);
  assert.strictEqual(state.abort, null);
  assert.strictEqual(T.el.input.value, '');
});

test('/test without a Google account on a document with text: the Docs API check is skipped, the export decides, the export rows', async () => {
  const b = await bench({ connected: false, selection: '' });
  await b.run('/test');
  deq(b.rows().map((r) => r.name), EXPORT_ROWS);
  const s = statusOf(b.rows());
  assert.strictEqual(s['Export read'], 'pass');
  deq([s['Docs API read'], b.row('Docs API read').detail], ['skip', 'Google account not connected']);
  assert.strictEqual(b.row('Empty document').detail, `the document is not empty (${EXPORT_MD.length} characters, 19 lines): open a new, empty Google Doc and run /test there`);
  assert.ok(!b.urls.some((u) => u.includes('docs.googleapis.com')), 'no Docs API call');
  assert.strictEqual(s.Completion, 'pass');
  assert.ok(b.live.includes('Self-test: 1 of 31 · Environment orbits'), b.live.join('\n'));
});

test('/test: a failing export (download disabled) fails that check and the gate; the harmless checks go on', async () => {
  const b = await bench({ connected: false, exportFail: true });
  await b.run('/test');
  const s = statusOf(b.rows());
  assert.strictEqual(s['Export read'], 'fail');
  assert.match(b.row('Export read').detail, /^Could not get the document text \(HTTP 403; download disabled\)\. · 3 export requests in this self-test$/);
  const gate = 'the document text is unavailable: Could not get the document text (HTTP 403; download disabled).'; // no second read
  deq([s['Empty document'], b.row('Empty document').detail], ['fail', gate]);
  assert.strictEqual(b.rows().length, 31);
  assert.strictEqual(b.row('read_lines').detail, `not run: ${gate}`);
  assert.strictEqual(b.row('Model: insert at the cursor').detail, `not run: ${gate}`);
  assert.strictEqual(s['Model list'], 'pass');
  assert.strictEqual(s.Completion, 'pass');
  assert.ok(b.card().innerHTML.includes('Send this report to the developer'));
  assert.match(b.card()._report, /\*\*Summary:\*\* \d+ passed, 0 warnings, 2 failed, \d+ skipped/);
});

test('/test: a provider reply other than OK is a warning, not a failure', async () => {
  const b = await bench({ reply: 'Sure, here you go.' });
  await b.run('/test');
  assert.strictEqual(b.row('Completion').status, 'warn');
  assert.match(b.row('Completion').detail, /reply «Sure, here you go\.»/);
  assert.match(b.row('Completion').more, /does not contain "OK"/);
  deq(b.rows().filter((r) => r.status === 'fail').map((r) => r.name), ['Empty document']); // the document has text
});

// Without an API key only the write cycle changes the document; it runs without a card.
test('/test on an empty document: the write cycle runs without a card, the reading checks run on its lines, the document ends empty', async () => {
  const b = await bench({ empty: true });
  const { state } = b;
  state.settings.providers.anthropic.apiKey = '';
  const before = JSON.stringify(state.messages);
  await b.run('/test');
  deq(b.cards, []);
  deq(b.rows().map((r) => r.name), API_ROWS);
  assert.strictEqual(b.row('Empty document').detail, 'empty: 0 characters, 1 line (Docs API) · nothing selected · write cycle (revision rev-1, 1 line) · no model scenarios (no Anthropic (Claude) API key)');
  for (const n of ['Write: insert_after_line', ...READING, ...API_EDITS]) assert.strictEqual(b.row(n).status, 'pass', `${n}: ${b.row(n).detail} ${b.row(n).more || ''}`);
  for (const n of MODEL_ROWS) deq([b.row(n).status, b.row(n).detail], ['skip', 'not run: no Anthropic (Claude) API key'], n);
  // the Your-turn cards are skipped: the replace row with them; nothing changed, so the paragraph is not rewritten
  deq(b.turns.length, 3);
  // while a card waits, the live row says so with the listening orb
  assert.ok(b.live.includes('Self-test: 17 of 40 · Your turn: select text · your turn (see the card below) wave'), b.live.join('\n'));
  assert.ok(b.live.includes('Self-test: 17 of 40 · Your turn: select text orbits'));
  deq(b.statuses.filter((x) => /self-test/i.test(x)), []);
  deq([b.row('Your turn: typing signal').status, b.row('Your turn: typing signal').detail], ['skip', 'skipped by the user']);
  deq([b.row('Your turn: select text').status, b.row('Your turn: select text').detail], ['skip', 'skipped by the user']);
  deq(b.row('Model: replace the selection').detail, 'not run: the selection step was skipped by the user');
  deq([b.row('Your turn: make text bold').status, b.row('Your turn: make text bold').detail], ['skip', 'skipped by the user']);
  const kinds = b.posts().map((body) => body.requests.map((q) => Object.keys(q)[0]).join('+'));
  // insert, replace_text, format_text, (the text styles: 2 format_text, 2 undos), format_lines ×2 and 2 undos, the list
  // items (insert, number, checklist, none, 3 undos, their deletion), page parts (a footer created and written, a footnote
  // created and written; two undos: the footnote text and its mark, the footer text and the footer), delete_lines, the
  // undo line and its undo
  const listRows = ['updateParagraphStyle', 'updateParagraphStyle', 'updateParagraphStyle', 'updateParagraphStyle',
    'insertText', 'createParagraphBullets', 'deleteParagraphBullets+createParagraphBullets', 'deleteParagraphBullets+updateParagraphStyle',
    'createParagraphBullets+updateParagraphStyle', 'deleteParagraphBullets+createParagraphBullets+updateParagraphStyle', 'deleteParagraphBullets+updateParagraphStyle',
    'deleteContentRange+updateParagraphStyle'];
  // Write: table: insert and fill, add a row and fill it, a width, delete the row; undo: the row again and its text, the
  // width, the added row, the table
  const tableRows = ['insertTable', 'insertText+insertText+insertText+insertText', 'insertTableRow', 'insertText+insertText', 'updateTableColumnProperties',
    'deleteTableRow', 'insertTableRow', 'insertText+insertText', 'updateTableColumnProperties', 'deleteTableRow', 'deleteContentRange'];
  const partRows = ['createFooter', 'insertText', 'createFootnote', 'insertText', 'deleteContentRange', 'deleteContentRange', 'deleteContentRange', 'deleteFooter'];
  deq(kinds, ['insertText', 'deleteContentRange+insertText', 'updateTextStyle', 'updateTextStyle', 'updateTextStyle', 'updateTextStyle', 'updateTextStyle', ...listRows, ...tableRows, ...partRows,
    'deleteContentRange+updateParagraphStyle', 'insertText', 'deleteContentRange+updateParagraphStyle']);
  assert.ok(b.posts().every((body) => body.writeControl && body.writeControl.requiredRevisionId));
  assert.strictEqual(b.fake.raw('t.0'), '');
  assert.match(b.row('Write: undo_last_edit').detail, /revision rev-1 → rev-42$/);
  assert.strictEqual(JSON.stringify(state.messages), before, 'the edit journal never reaches the chat');
  assert.ok(!b.card()._report.includes('Write cycle:'));
  assert.match(b.card()._report, /\*\*Summary:\*\* 23 passed, 1 warning, 0 failed, 16 skipped/);
  assert.strictEqual(state.busy, false);
});

test('/test: a failing write step stops the phase and the report names the leftover lines', async () => {
  const b = await bench({ empty: true });
  b.state.settings.providers.anthropic.apiKey = '';
  const { state } = b;
  const real = b.fake.fetch;
  let posts = 0;
  b.fake.fetch = async (url, init = {}) => {
    if (init.method === 'POST' && /docs\.googleapis/.test(url) && ++posts === 3) {
      return json({ error: { code: 400, message: 'Invalid requests[0].updateTextStyle', status: 'INVALID_ARGUMENT' } }, 400);
    }
    return real(url, init);
  };
  await b.run('/test');
  const s = statusOf(b.rows());
  assert.strictEqual(s['Write: insert_after_line'], 'pass');
  assert.strictEqual(s['Write: replace_text'], 'pass');
  assert.strictEqual(s['Write: format_text'], 'fail');
  const fail = b.row('Write: format_text');
  assert.match(fail.detail, /format_text failed/);
  assert.match(fail.detail, /Left in the document: line 2 «Self-test section», line 3 «The slow green turtle jumps over the lazy dog\.»\. Delete it by hand\.$/);
  assert.strictEqual(b.row('Write: delete_lines').detail, 'not run: an earlier write step failed');
  assert.strictEqual(b.row('Write: undo_last_edit').detail, 'not run: an earlier write step failed');
  assert.strictEqual(s['Multi-tab'], 'pass');
  assert.strictEqual(posts, 3, 'no write after the failure');
  assert.ok(b.card().innerHTML.includes('Send this report to the developer'));
  assert.strictEqual(b.fake.raw('t.0').split('\n').length, 3);
  assert.ok(!state.messages.some((m) => m._edit), 'the journal is not in the chat');
});

test('/test: Stop mid-run ends it and the report lists the checks that ran', async () => {
  const b = await bench({ onModels: (x) => x.state.abort.abort() });
  await b.run('/test');
  const rows = b.rows();
  deq(rows.map((r) => r.name), ['Environment', 'Content script', 'Change signal', 'Selection', 'Export read', 'Docs API read', 'Model list']);
  assert.strictEqual(b.bodies.length, 0, 'no completion after Stop');
  assert.ok(b.card()._selfTest.stopped);
  assert.match(b.card()._report, /stopped by the user after 7 of 40 checks/);
  assert.strictEqual(b.liveRow(), undefined, 'Stop: the live row is gone');
  assert.strictEqual(b.liveOrb.getAttribute('data-orb'), null, 'Stop: the orb loop stopped');
  assert.strictEqual(b.state.busy, false);
  assert.strictEqual(b.T.el.docStatus.textContent, b.T.docStatusText());
});

test('/test is refused while a turn runs and needs no API key', async () => {
  const b = await bench();
  b.state.busy = true;
  b.T.el.input.value = '/test';
  await b.T.sendMessage();
  assert.ok(!b.card());
  b.state.busy = false;
  b.state.settings.providers.anthropic.apiKey = '';
  await b.run('/test');
  const s = statusOf(b.rows());
  assert.strictEqual(s.Environment, 'warn');
  assert.strictEqual(s['Model list'], 'skip');
  assert.strictEqual(s.Completion, 'skip');
  assert.strictEqual(s['Docs API read'], 'pass');
});

test('Environment: the Google line names the signed-in account or the export + paste fallback; no client-ID check', async () => {
  let b = await bench({ connected: false });
  await b.run('/test');
  let r = b.row('Environment');
  assert.strictEqual(r.status, 'pass');
  assert.match(r.detail, / · API key set · Google: not signed in \(export \+ paste fallback\) · Mode: (Manual|Edit automatically|Plan) · Web Locks available · /);
  b = await bench({ connected: true, account: null });
  await b.run('/test');
  r = b.row('Environment');
  assert.strictEqual(r.status, 'pass');
  assert.match(r.detail, / · API key set · Google: signed in · Mode: (Manual|Edit automatically|Plan) · Web Locks available · /);
});

test('Environment: the row names the mode of the cycler', async () => {
  for (const [mode, label] of [['manual', 'Manual'], ['auto', 'Edit automatically'], ['plan', 'Plan']]) {
    const b = await bench({ connected: false });
    b.state.applyMode = mode;
    await b.run('/test');
    assert.ok(b.row('Environment').detail.includes(` · Mode: ${label} · `), mode);
  }
});
