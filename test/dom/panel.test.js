'use strict';
// The panel on a real DOM (jsdom): the click delegation of #chat (Copy, Apply to selection, Undo, Allow /
// Deny of open_document), the Files panel's box (the list: test/dom/instructions.test.js), the settings form (three provider
// blocks, an overlay), the Auto/Manual switch while busy,
// the chat switcher, the slash-command popup, the resizer, the theme toggle, the live answer bubble and the
// header raven that hides the panel (COLLAPSE_PANEL).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { load, click, mouse, key, typeInto, pointer, tick } = require('../lib/dom-sandbox');
const { deq, installDocTab, installIdentity, waitFor } = require('../lib/sandbox');
const { fakeDocsServer, docsBench } = require('../lib/fake-docs');
const { ev } = require('../lib/streams');
const { liveStream } = require('../lib/live-stream');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, el, document, storage, chrome, ident, bench, tabMsgs;
// A row of the Files list (MAIN.md: 'main', DOC.md: 'document', a file: its alias): the button that opens it.
const entry = (e) => el.filesList.querySelector(`[data-entry="${e}"] .file-open`);
const $$ = (sel, root) => [...(root || el.chat).querySelectorAll(sel)];

before(async () => {
  env = await load();
  ({ T, state, el, document, storage, chrome } = env);
  ident = installIdentity(env);
  bench = docsBench(env, ident, ref);
  installDocTab(env);
  tabMsgs = [];
  chrome.tabs.sendMessage = async (id, msg) => {
    tabMsgs.push(msg);
    switch (msg.type) {
      case 'PING': return { ok: true, title: 'My Doc' };
      case 'GET_SELECTION': return { ok: true, text: 'quick brown' };
      case 'GET_DOC_TEXT': return { ok: true, text: '# My Doc\n\nThe quick brown fox.', format: 'markdown', title: 'My Doc' };
      case 'REPLACE_SELECTION': return { ok: true };
      default: return { ok: true };
    }
  };
  await T.refreshContext({ force: true });
  assert.strictEqual(state.docId, 'DOC123');
});
after(() => env.close());

const answerHistory = () => [
  { role: 'user', content: 'Rewrite it' },
  { role: 'assistant', content: 'Answer with **bold**.\n\n```py\nprint(1)\n```\n\n```\nsecond block\n```' },
];

const blockHistory = () => [
  { role: 'user', content: 'Rewrite it' },
  { role: 'assistant', content: 'Here it is.\n\n<replacement>\nNew sentence.\n</replacement>' },
];

test('#chat delegation: Copy (edit block bar, code block; also from the inner icon), check mark, copy failure', async () => {
  state.messages = blockHistory();
  T.renderHistory();
  const bubbles = $$('.msg.assistant');
  assert.strictEqual(bubbles.length, 1);
  const copyMsg = bubbles[0].querySelector('.edit-block .code-bar button[data-act="copy-code"]');
  click(copyMsg.querySelector('svg path')); // a click on the icon bubbles to the button
  await tick(5);
  assert.deepStrictEqual(env.clipboard.writes, ['New sentence.']);
  assert.ok(copyMsg.classList.contains('done'));
  state.messages = answerHistory();
  T.renderHistory();
  const b = $$('.msg.assistant')[0];
  assert.strictEqual(b.querySelector('.edit-block'), null); // a plain answer: only its code blocks have buttons
  const codeCopy = b.querySelectorAll('.code-bar button[data-act="copy-code"]');
  assert.strictEqual(codeCopy.length, 2);
  click(codeCopy[1]);
  await tick(5);
  assert.strictEqual(env.clipboard.writes[1], 'second block');
  // a button outside any message bubble or with an unknown index does nothing
  const stray = document.createElement('button'); stray.dataset.act = 'copy-code'; stray.dataset.idx = '9';
  b.appendChild(stray); click(stray); await tick(5);
  assert.strictEqual(env.clipboard.writes.length, 2);
  env.clipboard.fail = 'denied';
  click(codeCopy[0]); await tick(5);
  assert.ok($$('.msg.error').some((e) => e.textContent === 'Could not copy: denied'));
  env.clipboard.fail = null;
});

test('#chat delegation: Apply to selection pastes with a check mark and no chat element; a failed paste shows its card', async () => {
  state.messages = answerHistory();
  T.renderHistory();
  tabMsgs.length = 0;
  const b = $$('.msg.assistant')[0];
  const before = el.chat.children.length;
  const apply = b.querySelector('.code-bar button[data-act="apply-code"]');
  click(apply);
  await waitFor(() => apply.classList.contains('done'), 'the check mark');
  assert.deepStrictEqual(tabMsgs.filter((m) => m.type === 'REPLACE_SELECTION').map((m) => m.text), ['print(1)']);
  assert.ok(apply.querySelector('svg.icon-check') && apply.querySelector('svg.icon-apply'));
  assert.strictEqual(el.chat.children.length, before, 'no new chat element');
  assert.strictEqual($$('.tool-card').length, 0);
  // the edit block's Apply (in its bar): the same, with exactly the block text
  state.messages = blockHistory();
  T.renderHistory();
  tabMsgs.length = 0;
  const corner = $$('.msg.assistant')[0].querySelector('.edit-block .code-bar button[data-act="apply-code"]');
  const n = el.chat.children.length;
  click(corner);
  await waitFor(() => corner.classList.contains('done'), 'the corner check mark');
  assert.deepStrictEqual(tabMsgs.filter((m) => m.type === 'REPLACE_SELECTION').map((m) => m.text), ['New sentence.']);
  assert.strictEqual(el.chat.children.length, n);
  // the paste fails: the text goes to the clipboard and the card says so
  const prevSend = chrome.tabs.sendMessage;
  chrome.tabs.sendMessage = async (id, msg) => (msg.type === 'REPLACE_SELECTION' ? { ok: false, error: 'paste event not handled' } : prevSend(id, msg));
  corner.classList.remove('done');
  click(corner);
  assert.strictEqual(corner.disabled, true); // while it runs
  await waitFor(() => $$('.tool-card').length === 1, 'the failure card');
  assert.strictEqual(corner.disabled, false);
  assert.ok(!corner.classList.contains('done'));
  const fail = $$('.tool-card')[0];
  assert.ok(fail.classList.contains('fail'));
  assert.ok(fail.textContent.includes('copied to the clipboard') && fail.textContent.includes('paste event not handled'));
  assert.strictEqual(env.clipboard.writes[env.clipboard.writes.length - 1], 'New sentence.');
  chrome.tabs.sendMessage = prevSend;
});

test('#chat delegation: Undo on the action-log row of the latest Docs API edit', async () => {
  await bench.fresh();
  state.googleConnected = true;
  const args = { old_text: 'Alpha beta gamma.', new_text: 'Alpha beta GAMMA.' };
  const r = await bench.exec('replace_text', args, 'toolu_u1');
  assert.ok(r._ok && r._edit, r.content);
  assert.ok(fake.text('t.0').includes('Alpha beta GAMMA.'));
  state.messages = [
    { role: 'user', content: 'Capitalize' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'toolu_u1', type: 'function', function: { name: 'replace_text', arguments: JSON.stringify(args) } }] },
    r,
    { role: 'assistant', content: 'Done.' },
  ];
  T.renderHistory();
  await T.saveHistory(); // Undo starts from the stored history
  assert.strictEqual($$('.tool-card').length, 0); // the row stands in for the card
  const undo = $$('.write-row .row-acts button[data-act="undo-edit"]');
  assert.strictEqual(undo.length, 1);
  assert.strictEqual(undo[0].dataset.edit, 'toolu_u1');
  click(undo[0]);
  await waitFor(() => !state.undoing && state.messages[2]._edit.undone, 'the undo');
  await tick(5);
  assert.strictEqual($$('.msg.chat-row, .note-row').length, 0); // the row says Undone; nothing else in the chat
  assert.ok(fake.text('t.0').includes('Alpha beta gamma.') && !fake.text('t.0').includes('GAMMA'));
  assert.strictEqual(state.messages[2]._edit.undone, true);
  const rows = $$('.write-row');
  assert.strictEqual(rows.length, 1); // re-rendered, not duplicated
  assert.ok(rows[0].classList.contains('undone'));
  assert.strictEqual(rows[0].querySelector('.log-status').textContent, 'Undone');
  assert.strictEqual($$('.tool-card').length, 0);
  assert.strictEqual($$('button[data-act="undo-edit"]').length, 0);
  state.googleConnected = false;
});

test('#chat delegation: Allow and Deny of the open_document gate (fake Docs server)', async () => {
  await bench.fresh();
  state.googleConnected = true;
  const OTHER = 'OTHERDOC9999999999999999999';
  const fake2 = fakeDocsServer({ documentId: OTHER, title: 'Other paper', tabs: [{ id: 't.0', title: 'Main', items: [{ p: 'Other paper', style: 'TITLE' }, { p: 'Body text.' }] }] });
  fake2.token = 'tok-1';
  env.ctx.fetch = async (url, init) => (url.includes(OTHER) ? fake2.fetch(url, init) : fake.fetch(url, init));
  const snap = T.takeSnapshot(); T.snapshotDocument(snap);
  snap.chatCtx = { docId: 'DOC123', chatId: state.chatId, messages: [{ role: 'user', content: 'Compare with the related paper.' }] };
  el.chat.textContent = '';
  const call = (id) => T.executeTool({ id, function: { name: 'open_document', arguments: JSON.stringify({ url: OTHER }) } }, 'edit', snap, {});
  // Deny: nothing is fetched
  let p = call('o1');
  await waitFor(() => $$('.tool-card.preview').length === 1, 'the permission card');
  const card = $$('.tool-card.preview')[0];
  assert.deepStrictEqual([...card.querySelectorAll('button[data-act]')].map((b) => b.textContent), ['Allow', 'Deny', 'Allow all in this turn']);
  assert.strictEqual(card.querySelector('.pv-line').textContent, OTHER);
  click(card.querySelector('button[data-act="preview-reject"]'));
  let r = await p;
  assert.strictEqual(r._decision, 'rejected');
  assert.strictEqual(r.content, T.OPEN_DENIED_TEXT);
  assert.ok(card.classList.contains('answered-row') && !card.classList.contains('tool-card') && card.isConnected);
  assert.strictEqual(fake2.log.length, 0);
  assert.strictEqual(card.querySelectorAll('button').length, 0); // answered: one row "open_document · Denied · <link>", no buttons
  assert.strictEqual(card.querySelector('.log-status').textContent, 'Denied');
  assert.ok(card.querySelector('summary').textContent.startsWith('open_document · Denied · '));
  assert.ok(card.querySelector('.log-body .log-asked').textContent.includes(OTHER));
  assert.strictEqual(JSON.stringify(r._answered.map((a) => [a.kind, a.decision])), '[["open","reject"]]');
  assert.strictEqual(T.pendingPreviews.size, 0);
  // Allow: the document is read through the Docs API
  p = call('o2');
  await waitFor(() => T.pendingPreviews.size === 1, 'the second card');
  click($$('.tool-card.preview:not(.decided) button[data-act="preview-accept"]')[0]);
  r = await p;
  assert.strictEqual(r._decision, 'accepted');
  assert.deepStrictEqual($$('.answered-row .log-status').map((x) => x.textContent), ['Denied', 'Allowed']);
  assert.ok(r._ok && r.content.startsWith('Opened as doc2. Title: "Other paper".'), r.content);
  assert.ok(fake2.log.some((x) => x.method === 'GET'));
  state.googleConnected = false;
});

test('#chat delegation: the self-test\'s Your-turn card has Skip only and ends when the panel sees the change; Stop ends the wait', async () => {
  el.chat.textContent = '';
  let seen;
  let p = T.confirmYourTurn('Select «brown fox».', null, { until: new Promise((r) => { seen = r; }) });
  let card = $$('.tool-card.your-turn')[0];
  assert.ok(card, 'the card');
  assert.deepStrictEqual([...card.querySelectorAll('button[data-act]')].map((b) => b.textContent), ['Skip']);
  assert.strictEqual(card.querySelector('.pv-note').textContent, 'Select «brown fox».');
  seen({ done: true }); // the self-test's watch saw the change: no click
  assert.strictEqual(await p, 'done');
  assert.ok(!card.isConnected, 'removed once decided');
  assert.strictEqual(T.pendingPreviews.size, 0);
  // a watch that ends without seeing anything (null) leaves the card waiting
  p = T.confirmYourTurn('Make it bold.', null, { until: Promise.resolve(null) });
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(T.pendingPreviews.size, 1);
  card = $$('.tool-card.your-turn')[0];
  click(card.querySelector('button[data-act="preview-skip"]'));
  assert.strictEqual(await p, 'skip');
  // Stop (the signal) and the timeout
  const ac = new env.window.AbortController();
  p = T.confirmYourTurn('Remove it.', ac.signal);
  ac.abort();
  assert.strictEqual(await p, 'stop');
  assert.strictEqual(await T.confirmYourTurn('Too late.', null, { timeoutMs: 5 }), 'timeout');
  assert.strictEqual($$('.tool-card.your-turn').length, 0);
});

test('the Your-turn card\'s selection line (showSelection): what the panel sees, escaped, updated by the pushes', async () => {
  el.chat.textContent = '';
  const saved = state.selection;
  state.selection = 'a <b>bold</b> & "x"';
  const p = T.confirmYourTurn('Select «brown fox».', null, { showSelection: true });
  const card = $$('.tool-card.your-turn')[0];
  const sees = card.querySelector('.pv-body .pv-sees');
  assert.strictEqual(sees.textContent, 'The panel sees: «a <b>bold</b> & "x"» (19 characters)');
  assert.ok(sees.innerHTML.includes('&lt;b&gt;bold&lt;/b&gt; &amp;'), sees.innerHTML);
  assert.strictEqual(card.querySelectorAll('b').length, 0, 'no markup from the selection');
  assert.strictEqual(T.showYourTurnSelection('x'), true);
  assert.strictEqual(sees.textContent, 'The panel sees: «x» (1 character)');
  T.showYourTurnSelection('');
  assert.strictEqual(sees.textContent, 'The panel sees nothing selected yet');
  T.showYourTurnSelection('word '.repeat(30));
  assert.strictEqual(sees.textContent, `The panel sees: «${'word '.repeat(16)}…» (150 characters)`);
  click(card.querySelector('button[data-act="preview-skip"]'));
  assert.strictEqual(await p, 'skip');
  assert.strictEqual(T.showYourTurnSelection('y'), false, 'no card waits');
  // without the option: no selection line
  const q = T.confirmYourTurn('Remove it.', null);
  assert.strictEqual($$('.tool-card.your-turn .pv-sees').length, 0);
  click($$('.tool-card.your-turn button[data-act="preview-skip"]')[0]);
  assert.strictEqual(await q, 'skip');
  state.selection = saved;
});

test('remember: the open section and the dot follow at once; no card, its row, no Revert', async () => {
  storage['muninDocInstructions:DOC123'] = 'Use British English.';
  state.docInstructions = 'Use British English.';
  click(el.filesBtn); click(entry('document')); // the list, then DOC.md below it
  assert.strictEqual(el.instructionsText.value, 'Use British English.');
  const tc = { id: 'toolu_rm1', type: 'function', function: { name: 'remember', arguments: JSON.stringify({ action: 'add', text: 'Keep the term "lipid raft".' }) } };
  const sn = T.takeSnapshot(); T.snapshotDocument(sn);
  const r = await T.executeTool(tc, 'edit', sn, {});
  assert.ok(r._ok, r.content);
  const both = 'Use British English.\nKeep the term "lipid raft".';
  assert.strictEqual(el.instructionsText.value, both); // no unsaved changes: the section shows the new text
  click(el.filesBtn); // the header button closes it again
  state.messages = [
    { role: 'user', content: 'Remember: keep the term "lipid raft".' },
    { role: 'assistant', content: null, tool_calls: [tc] }, r, { role: 'assistant', content: 'Noted.' },
  ];
  T.renderHistory();
  assert.strictEqual($$('.tool-card').length, 0);
  assert.strictEqual($$('button[data-act="revert-remember"]').length, 0);
  const row = $$('.activity-row.write-row')[0];
  assert.strictEqual(row.querySelector('summary').textContent, 'remember · Done · DOC.md: added «Keep the term "lipid raft".»');
  assert.strictEqual(row.querySelector('.log-what').textContent, 'Added to DOC.md: «Keep the term "lipid raft".»'); // no icon
  delete storage['muninDocInstructions:DOC123']; state.docInstructions = ''; state.messages = []; T.renderHistory();
});

test('Files: one box with maxlength as the limit, no counters, no Close of the section, no switch, no Write from the document', () => {
  const ta = el.instructionsText;
  assert.strictEqual(ta.getAttribute('maxlength'), '8000');
  assert.strictEqual(ta.maxLength, T.DOC_INSTRUCTIONS_MAX);
  for (const id of ['instructionsCount', 'userInstructionsCount', 'userInstructionsText', 'closeInstructions', 'paperCard', 'paperCardBuild', 'docInitRun',
    'instructions', 'instructionsBtn', 'instructionsMain', 'instructionsDoc']) {
    assert.strictEqual(document.getElementById(id), null, id);
  }
  assert.strictEqual(el.files.querySelectorAll('textarea').length, 1);
  assert.ok(!/characters|Write from the document/.test(el.files.textContent));
  deq([el.filesBtn.dataset.tip, el.filesBtn.getAttribute('aria-label')], [undefined, 'Files']);
  assert.ok(el.filesBtn.querySelector('svg'));
  click(el.filesBtn);
  assert.ok(!el.files.classList.contains('hidden'));
  assert.ok(el.filesPane.classList.contains('hidden')); // the list alone
  click(entry('document'));
  assert.strictEqual(document.activeElement, ta);
  click(el.filesBtn);
  assert.ok(el.files.classList.contains('hidden'));
});

test('settings form: the gear toggles, a press outside closes, no Save or Close; one row per account, Add provider, keys apply at once, the type comes first, Remove at once', async () => {
  const btn = document.getElementById('settingsBtn');
  const rows = () => [...document.querySelectorAll('#settings .provider-block')];
  const row = (id) => document.querySelector(`#settings .provider-block[data-account="${id}"]`);
  const keyOf = (id) => row(id).querySelector('.account-key');
  const statusOf = (id) => row(id).querySelector('.model-row + .hint');
  assert.strictEqual(document.getElementById('saveSettings'), null);
  assert.strictEqual(document.getElementById('closeSettings'), null);
  assert.strictEqual(document.getElementById('provider'), null); // no Chat provider dropdown: the chat picks its model
  // the rows show what storage holds
  Object.assign(storage, {
    muninAccounts: [{ id: 'munin', type: 'munin', name: 'Munin', apiKey: 'k-m' }, { id: 'openai', type: 'openai', name: 'OpenAI', apiKey: 'sk-o' },
      { id: 'anthropic', type: 'anthropic', name: 'Anthropic', apiKey: 'sk-ant-a' }],
    'muninModels:openai': ['gpt-6.1-sol', 'gpt-6-astra'], muninLastModel: { accountId: 'openai', model: 'gpt-6-astra' },
  });
  const kept = { googleConnected: state.googleConnected, googleAccount: state.googleAccount, references: state.settings.references };
  await T.loadSettings();
  Object.assign(state, { googleConnected: kept.googleConnected, googleAccount: kept.googleAccount }); state.settings.references = kept.references;
  state.chats.forEach((c) => { delete c.model; }); // the chats follow the last choice
  click(el.filesBtn); // the Files section closes when the settings open
  click(btn);
  assert.ok(!el.settings.classList.contains('hidden'));
  assert.ok(el.files.classList.contains('hidden'));
  deq(rows().map((b) => [b.dataset.account, b.dataset.provider]), [['munin', 'munin'], ['openai', 'openai'], ['anthropic', 'anthropic']]);
  for (const b of rows()) {
    deq([...b.querySelectorAll('input')].map((n) => n.className), ['account-name', 'account-key', 'account-max-tokens', 'account-temperature'] /* Munin's server is fixed: no URL field */);
    assert.strictEqual(b.querySelector('.account-key').type, 'password');
    // the head folds the row (existing rows start folded); × removes at once
    const toggle = b.querySelector('.provider-head .provider-toggle');
    deq([...b.querySelectorAll('button')].map((n) => n.textContent), [toggle.textContent, '×', '', 'Check provider', 'Advanced']); // '' = the eye (an icon)
    // the eye shows the key in clear text while pressed
    const eye = b.querySelector('.key-eye');
    click(eye);
    assert.strictEqual(b.querySelector('.account-key').type, 'text');
    assert.strictEqual(eye.getAttribute('aria-pressed'), 'true');
    click(eye);
    assert.strictEqual(b.querySelector('.account-key').type, 'password');
    deq([toggle.getAttribute('aria-expanded'), b.querySelector('.provider-body').classList.contains('hidden')], ['false', true]);
    deq([b.querySelector('.account-remove').dataset.tip, b.querySelector('.account-remove').getAttribute('aria-label')], ['Remove this provider', 'Remove this provider']);
    assert.strictEqual(b.querySelector('.provider-title').textContent, b.querySelector('.account-name').value);
  }
  // a click on the head unfolds the body and again folds it; kept while the panel lives, also after reopening
  const toggleOf = (id) => row(id).querySelector('.provider-toggle');
  click(toggleOf('munin'));
  deq([toggleOf('munin').getAttribute('aria-expanded'), row('munin').querySelector('.provider-body').classList.contains('hidden'), row('munin').classList.contains('open')], ['true', false, true]);
  click(btn); click(btn);
  assert.strictEqual(toggleOf('munin').getAttribute('aria-expanded'), 'true');
  click(toggleOf('munin'));
  assert.ok(row('munin').querySelector('.provider-body').classList.contains('hidden'));
  deq(rows().map((b) => b.querySelector('.account-key').value), ['k-m', 'sk-o', 'sk-ant-a']);
  deq([...row('openai').querySelectorAll('.account-models option')].map((o) => o.value), ['gpt-6.1-sol', 'gpt-6-astra']); // information only
  assert.strictEqual(document.activeElement, toggleOf('openai')); // the chat's account (folded: its head)
  pointer(btn, 'pointerdown'); click(btn); // the gear's own press does not count as outside
  assert.ok(el.settings.classList.contains('hidden'));
  click(btn);
  // presses inside the settings keep them open; outside (chat, composer, header) close them
  for (const inside of [el.settings, keyOf('munin'), row('anthropic').querySelector('select'), row('openai'), el.addProviderBtn, el.googleConnect, document.querySelector('#settings h2')]) {
    pointer(inside, 'pointerdown');
    assert.ok(!el.settings.classList.contains('hidden'), inside.id || inside.className || inside.tagName);
  }
  for (const outside of [el.chat, el.input, el.modeCycle, document.querySelector('.topbar'), el.newChatBtn]) {
    if (el.settings.classList.contains('hidden')) click(btn);
    assert.ok(!el.settings.classList.contains('hidden'));
    pointer(outside, 'pointerdown');
    assert.ok(el.settings.classList.contains('hidden'), outside.id || outside.className);
  }
  click(btn);
  assert.strictEqual(env.window.document.getElementById('effort'), null); // no Effort field (nor Base URL / Model text fields)
  // Add provider: a second OpenAI account, its key field focused
  const fetched = [];
  env.ctx.fetch = async (url, init) => { fetched.push([url, init.headers['x-api-key'] || init.headers.Authorization]); return { ok: true, status: 200, json: async () => ({ data: [{ id: 'claude-opus-5-5' }, { id: 'gpt-6.1-sol' }, { id: 'gpt-6-mini' }] }), text: async () => '' }; };
  // one button (no menu): it adds a draft row, unfolded, with the type dropdown first; nothing is stored before a type
  assert.strictEqual(document.querySelectorAll('#settings .add-provider button').length, 1);
  assert.strictEqual(el.addProviderBtn.getAttribute('aria-haspopup'), null);
  const storedBefore = JSON.stringify(storage.muninAccounts);
  const draft = () => document.querySelector('#settings .provider-block.account-draft');
  click(el.addProviderBtn);
  assert.ok(draft() && rows().length === 4 && rows()[3] === draft());
  assert.strictEqual(draft().querySelector('.provider-toggle').getAttribute('aria-expanded'), 'true');
  assert.strictEqual(draft().querySelector('.provider-title').textContent, 'New provider');
  const typeSel = draft().querySelector('.provider-body > label:first-child select.account-type');
  assert.strictEqual(document.activeElement, typeSel);
  deq([...typeSel.options].map((o) => [o.value, o.textContent]),
    [['', ''], ['munin', 'Munin'], ['openai', 'OpenAI'], ['anthropic', 'Anthropic'], ['custom', 'Custom (OpenAI-compatible)']]);
  assert.strictEqual(typeSel.value, ''); // no type pre-selected
  assert.strictEqual(draft().querySelector('.account-draft-hint'), null); // the dropdown's first option is the only prompt
  assert.strictEqual(draft().querySelector('.account-key, .account-name, .account-url'), null);
  click(el.addProviderBtn); // a second click keeps the one draft
  assert.strictEqual(document.querySelectorAll('#settings .account-draft').length, 1);
  // folded, removed or the settings closed before a type is chosen: it just goes
  click(draft().querySelector('.provider-toggle'));
  assert.strictEqual(draft(), null);
  click(el.addProviderBtn);
  click(draft().querySelector('.account-remove'));
  assert.strictEqual(draft(), null);
  click(el.addProviderBtn);
  pointer(el.chat, 'pointerdown');
  assert.ok(el.settings.classList.contains('hidden'));
  click(btn);
  assert.strictEqual(draft(), null);
  assert.strictEqual(rows().length, 3);
  await tick(20);
  assert.strictEqual(JSON.stringify(storage.muninAccounts), storedBefore); // nothing was stored
  // a type: the account is stored and its row gets that type's fields; its key field is focused
  click(el.addProviderBtn);
  const chosen = draft().querySelector('select.account-type');
  chosen.value = 'openai';
  chosen.dispatchEvent(new env.window.Event('change', { bubbles: true }));
  await waitFor(() => rows().length === 4 && !draft(), 'the new row');
  const added = rows()[3].dataset.account;
  assert.strictEqual(storage.muninAccounts[3].type, 'openai');
  assert.ok(!row(added).querySelector('select.account-type').classList.contains('hidden')); // no key yet: the type may change
  assert.strictEqual(row(added).querySelector('select.account-type').value, 'openai');
  assert.strictEqual(row(added).querySelector('.account-url'), null); // OpenAI: no server URL
  assert.strictEqual(row(added).querySelector('.account-key').placeholder, 'sk-...');
  assert.strictEqual(rows()[3].querySelector('.account-name').value, 'OpenAI 2');
  assert.strictEqual(rows()[3].querySelector('.provider-toggle').getAttribute('aria-expanded'), 'true'); // a new row opens unfolded
  assert.ok(!rows()[3].querySelector('.provider-type').classList.contains('hidden')); // "OpenAI 2" is not the type's name
  assert.strictEqual(document.activeElement, keyOf(added));
  typeInto(keyOf(added), 'wrong-prefix');
  assert.ok(!row(added).querySelector('.hint.warn').classList.contains('hidden'));
  // a typed key fixes the type: the dropdown becomes text
  assert.ok(row(added).querySelector('select.account-type').classList.contains('hidden'));
  assert.ok(!row(added).querySelector('.account-type-fixed').classList.contains('hidden'));
  assert.strictEqual(row(added).querySelector('.account-type-fixed').textContent, 'OpenAI');
  typeInto(keyOf(added), 'sk-new');
  assert.ok(row(added).querySelector('.hint.warn').classList.contains('hidden'));
  // the key: stored after the 0.7 s pause, then checked with it
  await tick(300);
  assert.strictEqual(fetched.length, 0);
  await waitFor(() => { const a = state.settings.accounts.find((x) => x.name === 'OpenAI 2'); return a && a.health && a.health.ok && statusOf(added).textContent === ''; }, 'the key check');
  deq(fetched, [['https://api.openai.com/v1/models', 'Bearer sk-new']]);
  assert.strictEqual(storage.muninAccounts[3].apiKey, 'sk-new');
  deq(storage.muninAccounts.slice(0, 3).map((a) => a.apiKey), ['k-m', 'sk-o', 'sk-ant-a']); // the others keep theirs
  assert.ok(!el.settings.classList.contains('hidden')); // the settings stay open
  // a name, stored when the field is left (made unique)
  const name = row(added).querySelector('.account-name');
  name.value = 'OpenAI';
  name.dispatchEvent(new env.window.Event('change', { bubbles: true }));
  await waitFor(() => storage.muninAccounts[3].name === 'OpenAI 2', 'the unique name');
  name.value = 'Work';
  name.dispatchEvent(new env.window.Event('change', { bubbles: true }));
  await waitFor(() => storage.muninAccounts[3].name === 'Work', 'the new name');
  // "Check provider" asks that account with its key
  fetched.length = 0;
  click(row('anthropic').querySelector('.account-check'));
  await waitFor(() => fetched.some((u) => /anthropic\.com\/v1\/models/.test(u)) && row('anthropic').querySelector('select').options.length > 0, 'the Anthropic check'); // the status line stays empty: the list shows the models
  deq(fetched, [['https://api.anthropic.com/v1/models?limit=100', 'sk-ant-a']]);
  // the key on leaving the field, before the pause
  typeInto(keyOf('munin'), 'k-m2');
  keyOf('munin').dispatchEvent(new env.window.FocusEvent('blur'));
  await waitFor(() => storage.muninAccounts[0].apiKey === 'k-m2', 'the Munin key stored on blur');
  // × removes at once (no confirmation), with the cached list
  storage[`muninModels:${added}`] = ['gpt-6.1-sol'];
  assert.strictEqual(row(added).querySelector('.account-confirm'), null);
  click(row(added).querySelector('.account-remove'));
  assert.strictEqual(row(added), null);
  await waitFor(() => rows().length === 3 && storage.muninAccounts.length === 3 && !(`muninModels:${added}` in storage), 'the removed row and its list');
  // typing and a click outside at once: stored on closing; the check reports in the chat
  typeInto(keyOf('anthropic'), 'sk-ant-away');
  pointer(el.chat, 'pointerdown');
  assert.ok(el.settings.classList.contains('hidden'));
  await waitFor(() => storage.muninAccounts[2].apiKey === 'sk-ant-away', 'the key stored on closing');
  await waitFor(() => { const a = state.settings.accounts.find((x) => x.type === 'anthropic'); return a && a.health && a.health.ok && 'muninModels:anthropic' in storage && !T.settingsForm.checking.anthropic && !T.settingsForm.pending.anthropic; }, 'the key check settled'); // no chat notice any more; the second check (on closing) must settle before the next test
  state.settings.provider = 'munin'; // the other tests run on Munin (test/lib/legacy-settings.js)
});

test('model menu: the label opens it; grouped by account with the health dot; a pick applies to this chat, a new chat inherits it; only models (no Check provider, no typed id); Escape and a press outside close it', async () => {
  const menu = el.modelMenu;
  const picks = () => [...menu.querySelectorAll('.model-pick')].map((b) => `${b.dataset.account}/${b.dataset.model}`);
  state.modelLists.munin = ['qwen3.8-27b'];
  state.modelLists.openai = ['gpt-6.1-sol', 'gpt-6-mini'];
  state.modelLists.anthropic = []; delete storage['muninModels:anthropic']; // no list anywhere: asked for on opening
  await tick(50); state.modelLists.anthropic = []; // a storage change from the previous test's check may land late
  const asked = [];
  env.ctx.fetch = async (url) => { asked.push(url); return { ok: true, status: 200, json: async () => ({ data: [{ id: 'claude-opus-5-5' }, { id: 'claude-sonnet-5-5' }] }), text: async () => '' }; };
  await T.setChatModel('munin', 'qwen3.8-27b');
  const firstChat = state.chatId;
  click(el.chatModel);
  assert.ok(!menu.classList.contains('hidden'));
  assert.strictEqual(el.chatModel.getAttribute('aria-expanded'), 'true');
  deq([...menu.querySelectorAll('.model-group-name')].map((n) => n.textContent), ['Munin', 'OpenAI', 'Anthropic']);
  deq([...menu.querySelectorAll('.model-group-type')].map((n) => n.textContent), ['Munin', 'OpenAI', 'Anthropic']);
  await waitFor(() => picks().includes('anthropic/claude-sonnet-5-5'), 'the Anthropic list fetched on opening');
  deq(asked, ['https://api.anthropic.com/v1/models?limit=100']);
  deq(picks(), ['munin/qwen3.8-27b', 'openai/gpt-6.1-sol', 'openai/gpt-6-mini', 'anthropic/claude-opus-5-5', 'anthropic/claude-sonnet-5-5']);
  assert.strictEqual(menu.querySelector('.model-pick.active').dataset.model, 'qwen3.8-27b'); // the chat's model is checked
  // the accounts and their models, nothing else: no Check provider, no input row, no other actions
  assert.strictEqual(menu.querySelector('.model-check, .model-custom, .model-use, input, select'), null);
  assert.ok(![...menu.querySelectorAll('button')].some((b) => /Check provider/.test(b.textContent)));
  deq([...menu.querySelectorAll('button')].map((b) => b.className.includes('model-pick')), picks().map(() => true));
  // a down mark: the red dot with the reason, live
  T.markAccountHealth('openai', Object.assign(new Error('x'), { status: 503, serverMessage: 'overloaded' }));
  const dot = menu.querySelector('.model-group[data-account="openai"] .health-dot');
  assert.ok(dot.classList.contains('down'));
  assert.match(dot.dataset.tip, /^Not reachable: HTTP 503: overloaded \(checked /);
  assert.ok(!dot.classList.contains('ok'));
  // a chat request that got through, the list cached: green, "Reachable: N models, chat works"; the Anthropic list
  // fetched on opening verified it too
  T.markAccountHealth('openai', null);
  const dotOf = (id) => menu.querySelector(`.model-group[data-account="${id}"] .health-dot`);
  assert.ok(dotOf('openai').classList.contains('ok') && !dotOf('openai').classList.contains('down'));
  assert.match(dotOf('openai').dataset.tip, /^Reachable: 2 models, chat works \(checked /);
  assert.ok(dotOf('anthropic').classList.contains('ok'));
  // a rejected key: grey again (unknown)
  T.markAccountHealth('munin', 1);
  assert.match(dotOf('munin').dataset.tip, /^Reachable: 1 model \(checked /);
  T.markAccountHealth('munin', Object.assign(new Error('bad key'), { status: 401 }));
  assert.ok(!dotOf('munin').classList.contains('ok') && !dotOf('munin').classList.contains('down'));
  assert.strictEqual(dotOf('munin').dataset.tip, 'Not checked yet');
  // a pick: this chat runs on it from the next message on; the menu closes
  click(menu.querySelector('.model-pick[data-model="claude-sonnet-5-5"]'));
  assert.ok(menu.classList.contains('hidden'));
  await waitFor(() => el.chatModel.textContent === 'claude-sonnet-5-5', 'the label');
  // the model button's dot: green while the chat's account is verified, red while it is down, grey while unknown
  assert.ok(el.chatModel.classList.contains('ok') && !el.chatModel.classList.contains('down'));
  assert.match(el.chatModel.dataset.tip, /\nReachable: 2 models \(checked /);
  T.markAccountHealth('anthropic', Object.assign(new Error('x'), { status: 502 }));
  assert.ok(el.chatModel.classList.contains('down') && !el.chatModel.classList.contains('ok'));
  T.markAccountHealth('anthropic', Object.assign(new Error('x'), { status: 401 }));
  assert.ok(!el.chatModel.classList.contains('down') && !el.chatModel.classList.contains('ok'));
  assert.ok(!el.chatModel.dataset.tip.includes('\n'));
  T.markAccountHealth('anthropic', 2);
  deq(T.chatChoice(), { accountId: 'anthropic', model: 'claude-sonnet-5-5' });
  await waitFor(() => (storage['muninChats:DOC123'].find((c) => c.id === firstChat).model || {}).accountId === 'anthropic', 'the stored chat meta');
  const meta = storage['muninChats:DOC123'].find((c) => c.id === firstChat);
  deq([meta.model.accountId, meta.model.model], ['anthropic', 'claude-sonnet-5-5']);
  deq(storage.muninLastModel, { accountId: 'anthropic', model: 'claude-sonnet-5-5' });
  // a new chat inherits it
  state.messages = [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }]; // a chat with messages is left, not reused
  await T.createChat();
  assert.notStrictEqual(state.chatId, firstChat);
  assert.strictEqual(el.chatModel.textContent, 'claude-sonnet-5-5');
  // another pick in the new chat
  click(el.chatModel);
  click(menu.querySelector('.model-pick[data-model="qwen3.8-27b"]'));
  await waitFor(() => el.chatModel.textContent === 'qwen3.8-27b', 'the second pick');
  deq(T.chatChoice(), { accountId: 'munin', model: 'qwen3.8-27b' });
  // the first chat kept its own
  const second = state.chatId;
  await T.switchChat(firstChat);
  assert.strictEqual(el.chatModel.textContent, 'claude-sonnet-5-5');
  await T.switchChat(second);
  // Escape and a press outside close it
  click(el.chatModel);
  key(el.chatModel, 'Escape');
  assert.ok(menu.classList.contains('hidden'));
  assert.strictEqual(document.activeElement, el.chatModel);
  click(el.chatModel);
  mouse(el.chat, 'mousedown');
  assert.ok(menu.classList.contains('hidden'));
  state.settings.provider = 'munin';
});

test('settings and files open over the chat: an overlay below the header that takes no layout height', () => {
  const css = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'sidepanel.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (sel) => [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => m[1].split(',').map((x) => x.trim()).includes(sel)).map((m) => m[2]).join(';');
  assert.ok(/position:\s*absolute/.test(rule('.settings')) && /top:\s*100%/.test(rule('.settings')) && /overflow-y:\s*auto/.test(rule('.settings')));
  assert.ok(/box-shadow/.test(rule('.settings')) && /background:/.test(rule('.settings')));
  assert.ok(/position:\s*relative/.test(rule('.top-stack')));
  // both sections sit with the header in .top-stack; the chat and the composer follow outside it
  const stack = document.querySelector('.top-stack');
  assert.ok(stack.contains(document.querySelector('.topbar')) && stack.contains(el.settings) && stack.contains(el.files));
  assert.ok(!stack.contains(el.chat) && stack.nextElementSibling === el.chat);
  // the bottom pane's room does not depend on an open section (it used to subtract the section's height)
  Object.defineProperty(el.settings, 'offsetHeight', { configurable: true, get: () => 500 });
  const closed = T.maxInputHeight();
  click(document.getElementById('settingsBtn'));
  assert.ok(!el.settings.classList.contains('hidden'));
  assert.strictEqual(T.maxInputHeight(), closed);
  click(document.getElementById('settingsBtn'));
  delete el.settings.offsetHeight;
});

test('files close on a press outside like the settings; presses inside and the button keep the toggle', async () => {
  const key = 'muninDocInstructions:DOC123';
  delete storage[key]; state.docInstructions = '';
  click(el.filesBtn);
  assert.ok(!el.files.classList.contains('hidden'));
  click(entry('document'));
  for (const inside of [el.files, el.instructionsText, entry('main'), el.filesAdd, el.filesPaneName, document.querySelector('#files h2')]) {
    pointer(inside, 'pointerdown');
    assert.ok(!el.files.classList.contains('hidden'), inside.id || inside.tagName);
  }
  pointer(el.filesBtn, 'pointerdown'); click(el.filesBtn); // the button's own press toggles
  assert.ok(el.files.classList.contains('hidden'));
  for (const outside of [el.chat, el.input, el.modeCycle, document.querySelector('.topbar'), el.newChatBtn]) {
    click(el.filesBtn);
    assert.ok(!el.files.classList.contains('hidden'));
    pointer(outside, 'pointerdown');
    assert.ok(el.files.classList.contains('hidden'), outside.id || outside.className);
  }
  // typed text is saved on that close
  click(el.filesBtn); click(entry('document'));
  typeInto(el.instructionsText, 'Use British English.');
  pointer(el.chat, 'pointerdown');
  assert.ok(el.files.classList.contains('hidden'));
  await waitFor(() => storage[key] === 'Use British English.' && state.docInstructions === 'Use British English.', 'the save on the press outside');
  delete storage[key]; state.docInstructions = '';
});

test('settings form: the version line from the manifest', () => {
  assert.strictEqual(document.getElementById('settingsVersion').textContent, 'Version 9.8.7');
});

test('selection: the panel chrome does not select with the mouse, the content does', () => {
  const css = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'sidepanel.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({ sel: m[1].split(',').map((x) => x.trim()), body: m[2] }));
  const selectorsWith = (re) => rules.filter((r) => re.test(r.body)).flatMap((r) => r.sel);
  const none = selectorsWith(/(^|[\s;])user-select:\s*none/);
  const text = selectorsWith(/(^|[\s;])user-select:\s*text/);
  for (const s of ['.topbar', '.settings', '.composer', '.cmd-popup', '.chat-menu', 'button']) assert.ok(none.includes(s), s);
  for (const s of ['input', 'textarea', '.sel-preview', '.sel-full', '.file-viewer']) assert.ok(text.includes(s), s); // the viewer's text too
  // nothing of the chat's content is excluded
  for (const s of none) assert.ok(!/^(\.chat|#chat|\.msg|\.tool-card|\.check-report|\.selftest|body|html|\*)$/.test(s), s);
  // the elements: chrome inside the excluded containers, content outside them
  const matchesNone = (node) => none.some((s) => !s.includes(':') && node.closest(s));
  for (const node of [el.docStatus, el.modeCycle, document.querySelector('.sel-label'), document.getElementById('contextText'),
    document.querySelector('#settings h2'), el.googleStatus, el.filesAdd, el.filesList]) assert.ok(matchesNone(node), node.id || node.className);
  state.messages = answerHistory(); T.renderHistory();
  const bubble = $$('.msg.assistant')[0];
  assert.ok(!matchesNone(bubble) && !matchesNone(bubble.querySelector('p') || bubble));
  assert.ok(matchesNone(bubble.querySelector('button[data-act="copy-code"]'))); // its buttons are chrome
  state.messages = []; T.renderHistory();
});

test('settings form: the Google label\'s tooltip in its three states; Sign in with Google through the button updates it', async () => {
  const was = { connected: state.googleConnected, account: state.googleAccount, fetch: env.ctx.fetch };
  const shown = (e) => !e.classList.contains('hidden');
  click(document.getElementById('settingsBtn'));
  assert.ok(!document.getElementById('googleClientId') && el.googleSwitch);
  assert.strictEqual(document.querySelector('.google-status'), null); // no "Signed in as" line
  assert.ok(!/Signed in as/.test(document.querySelector('.google-row').textContent));
  // not signed in
  state.googleConnected = false; T.renderGoogleStatus();
  deq([el.googleStatus.textContent, el.googleStatus.dataset.tip], ['Google account', 'Not signed in']);
  assert.ok(shown(el.googleConnect) && !shown(el.googleSwitch) && !shown(el.googleDisconnect));
  assert.strictEqual(el.googleConnect.textContent, 'Sign in with Google');
  // signed in with the account's email, and without it
  state.googleConnected = true; state.googleAccount = { email: 'ann@example.com', name: 'Ann' }; T.renderGoogleStatus();
  deq([el.googleStatus.textContent, el.googleStatus.dataset.tip], ['Google account', 'Signed in as ann@example.com']);
  assert.ok(!shown(el.googleConnect) && shown(el.googleSwitch) && shown(el.googleDisconnect));
  deq([el.googleSwitch.textContent, el.googleDisconnect.textContent], ['Switch account', 'Sign out']);
  state.googleAccount = null; T.renderGoogleStatus();
  assert.strictEqual(el.googleStatus.dataset.tip, 'Signed in');
  // the button: the account chooser, then the userinfo request
  state.googleConnected = false; T.renderGoogleStatus();
  ident.calls.length = 0;
  env.ctx.fetch = async (url, init) => (url === 'https://openidconnect.googleapis.com/v1/userinfo'
    ? { ok: true, status: 200, json: async () => ({ email: 'bob@example.com' }) } : was.fetch(url, init));
  click(el.googleConnect);
  await waitFor(() => el.googleStatus.dataset.tip === 'Signed in as bob@example.com', 'the signed-in tooltip');
  deq(ident.calls, [true]);
  assert.ok(shown(el.googleSwitch) && !shown(el.googleConnect));
  click(el.googleDisconnect);
  await waitFor(() => el.googleStatus.dataset.tip === 'Not signed in', 'the tooltip after Sign out');
  assert.ok(shown(el.googleConnect) && !shown(el.googleSwitch) && !shown(el.googleDisconnect));
  click(document.getElementById('settingsBtn'));
  delete storage.muninGoogleAccount;
  Object.assign(state, { googleConnected: was.connected, googleAccount: was.account }); env.ctx.fetch = was.fetch;
});

test('document instructions: no Save; saved after a 1 s pause, on leaving the field and on closing', async () => {
  const key = 'muninDocInstructions:DOC123';
  delete storage[key]; state.docInstructions = '';
  assert.strictEqual(document.getElementById('saveInstructions'), null);
  click(el.filesBtn); click(entry('document'));
  typeInto(el.instructionsText, 'Use British English.');
  await tick(500);
  assert.ok(!(key in storage)); // still typing
  await waitFor(() => storage[key] === 'Use British English.', 'the save after the pause');
  assert.strictEqual(state.docInstructions, 'Use British English.');
  assert.ok(!el.files.classList.contains('hidden')); // stays open
  typeInto(el.instructionsText, 'Use British English.\nTarget: Nature.');
  el.instructionsText.dispatchEvent(new env.window.FocusEvent('blur'));
  await waitFor(() => storage[key] === 'Use British English.\nTarget: Nature.', 'the save on blur');
  typeInto(el.instructionsText, 'Keep it short.');
  click(el.filesBtn); // closing with the header button
  assert.ok(el.files.classList.contains('hidden'));
  await waitFor(() => storage[key] === 'Keep it short.', 'the save on closing');
  click(el.filesBtn); click(entry('document'));
  typeInto(el.instructionsText, '');
  click(document.getElementById('settingsBtn')); // opening the settings closes the section: saved too
  await waitFor(() => !(key in storage), 'the empty text removes the key');
  await tick(5);
  click(document.getElementById('settingsBtn'));
  assert.ok(!$$('.msg').some((n) => /Document instructions (saved|removed)/.test(n.textContent))); // nothing in the chat
});

test('theme toggle: data-theme on <html>, the logo and the stored choice', async () => {
  const root = document.documentElement;
  const before = root.getAttribute('data-theme');
  assert.ok(before === 'dark' || before === 'light');
  click(document.getElementById('themeBtn'));
  const afterTheme = before === 'dark' ? 'light' : 'dark';
  assert.strictEqual(root.getAttribute('data-theme'), afterTheme);
  assert.ok(el.brandLogo.getAttribute('src').endsWith(`icon48-${afterTheme}.png`));
  await tick(5);
  assert.strictEqual(storage.muninTheme, afterTheme);
  click(document.getElementById('themeBtn'));
  assert.strictEqual(root.getAttribute('data-theme'), before);
});

test('slash-command popup: opens on "/", filters, arrows, Enter inserts without sending, Escape closes', async () => {
  const sent = [];
  env.ctx.fetch = async (url) => { sent.push(url); throw new Error('no network'); };
  const input = el.input;
  const popup = el.cmdPopup;
  const rows = () => [...popup.querySelectorAll('.cmd-row')];
  typeInto(input, '/');
  assert.ok(!popup.classList.contains('hidden'));
  assert.deepStrictEqual(rows().map((r) => r.querySelector('.cmd-name').textContent), ['/research', '/code', '/chat', '/review', '/side', '/check', '/polish', '/test']);
  assert.ok(rows()[0].classList.contains('active'));
  key(input, 'ArrowDown');
  assert.ok(rows()[1].classList.contains('active') && rows()[1].getAttribute('aria-selected') === 'true');
  key(input, 'ArrowUp'); key(input, 'ArrowUp'); // wraps to the last command
  assert.ok(rows()[rows().length - 1].classList.contains('active'));
  typeInto(input, '/c');
  assert.deepStrictEqual(rows().map((r) => r.querySelector('.cmd-name').textContent), ['/code', '/chat', '/check']);
  typeInto(input, '/ch');
  assert.deepStrictEqual(rows().map((r) => r.querySelector('.cmd-name').textContent), ['/chat', '/check']);
  assert.match(rows()[1].querySelector('.cmd-desc').textContent, /^Pre-submission report/);
  typeInto(input, '/cha');
  assert.deepStrictEqual(rows().map((r) => r.querySelector('.cmd-name').textContent), ['/chat']);
  const enter = key(input, 'Enter');
  assert.ok(enter.defaultPrevented);
  assert.strictEqual(input.value, '/chat ');
  assert.strictEqual(input.selectionStart, 6);
  assert.ok(popup.classList.contains('hidden'));
  assert.strictEqual(rows().length, 0);
  // the rest of the text after the token is kept; no match closes; Escape closes; the caret outside the token closes
  typeInto(input, '/re   fix this', 3);
  assert.strictEqual(rows().length, 2); // /research, /review
  typeInto(input, '/res   fix this', 4);
  assert.strictEqual(rows().length, 1);
  key(input, 'Tab');
  assert.strictEqual(input.value, '/research fix this');
  typeInto(input, '/zzz');
  assert.ok(popup.classList.contains('hidden'));
  typeInto(input, '/');
  key(input, 'Escape');
  assert.ok(popup.classList.contains('hidden'));
  typeInto(input, '/co hello', 9);
  assert.ok(popup.classList.contains('hidden'));
  // a mouse pick
  typeInto(input, '/');
  mouse(rows()[1], 'mousedown');
  assert.strictEqual(input.value, '/code ');
  await tick(5);
  assert.deepStrictEqual(sent, []); // nothing was sent
  input.value = '';
});

test('self-test report card: Copy report copies the Markdown; a failure adds the hint; long details expand', async () => {
  const report = {
    at: Date.now(), total: 2, stopped: false, leftover: '',
    header: { version: '1.0', chrome: '140', provider: 'Munin', model: 'm', google: 'not connected', title: 'My Doc', docId: 'DOC123', docsTab: '(first tab)', browserTab: 7 },
    rows: [{ name: 'Environment', ms: 1, status: 'pass', detail: 'v1.0' }, { name: 'Export read', ms: 2, status: 'fail', detail: 'download disabled', more: 'line one\nline two' }],
  };
  const card = T.selfTestCard(report);
  assert.ok(card.classList.contains('selftest') && card.classList.contains('report'));
  assert.strictEqual(card.querySelectorAll('.st-row').length, 2);
  assert.strictEqual(card.querySelector('details.st-row pre').textContent, 'line one\nline two');
  assert.ok(card.querySelector('.st-hint').textContent.includes('Send this report to the developer'));
  assert.strictEqual(card.querySelector('.st-summary').textContent, '1 passed, 0 warnings, 1 failed, 0 skipped');
  env.clipboard.writes.length = 0;
  click(card.querySelector('button[data-act="copy-selftest"]'));
  await tick(5);
  assert.strictEqual(env.clipboard.writes.length, 1);
  assert.strictEqual(env.clipboard.writes[0], T.selfTestMarkdown(report));
  assert.ok(env.clipboard.writes[0].includes('| 2 | Export read | fail | 2 ms | download disabled |'));
  card.remove();
});

test('slash-command popup: one /test entry with its description', async () => {
  const input = el.input;
  const rows = () => [...el.cmdPopup.querySelectorAll('.cmd-row')];
  typeInto(input, '/te');
  assert.deepStrictEqual(rows().map((r) => r.querySelector('.cmd-name').textContent), ['/test']);
  assert.match(rows()[0].querySelector('.cmd-desc').textContent, /^Self-test on a new, empty document: checks, a write cycle and model edits; the document ends empty$/);
  key(input, 'Enter');
  assert.strictEqual(input.value, '/test ');
  input.value = '';
});

test('resizer: dragging the splitter changes the input pane height and stores it; arrow keys too', async () => {
  const comp = el.composer;
  // jsdom has no layout: the pane's offsetHeight follows its style height
  Object.defineProperty(comp, 'offsetHeight', { configurable: true, get: () => parseFloat(comp.style.height) || 0 });
  const h0 = parseFloat(comp.style.height);
  assert.ok(h0 > 0, 'initial height ' + comp.style.height);
  pointer(el.splitter, 'pointerdown', { clientY: 500 });
  assert.ok(el.splitter.classList.contains('dragging') && document.body.classList.contains('resizing'));
  pointer(el.splitter, 'pointermove', { clientY: 400 });
  assert.strictEqual(parseFloat(comp.style.height), h0 + 100);
  pointer(el.splitter, 'pointermove', { clientY: 350 });
  assert.strictEqual(parseFloat(comp.style.height), h0 + 150);
  assert.strictEqual(el.splitter.getAttribute('aria-valuenow'), String(h0 + 150));
  pointer(el.splitter, 'pointerup', { clientY: 350 });
  assert.ok(!el.splitter.classList.contains('dragging') && !document.body.classList.contains('resizing'));
  await tick(5);
  assert.strictEqual(storage.muninInputHeight, h0 + 150);
  pointer(el.splitter, 'pointermove', { clientY: 0 }); // not dragging: ignored
  assert.strictEqual(parseFloat(comp.style.height), h0 + 150);
  // dragging far up is clamped to the space the window leaves
  pointer(el.splitter, 'pointerdown', { clientY: 500 });
  pointer(el.splitter, 'pointermove', { clientY: -5000 });
  pointer(el.splitter, 'pointercancel', {});
  const maxH = parseFloat(comp.style.height);
  assert.ok(maxH < env.window.innerHeight && maxH > h0 + 150, String(maxH));
  key(el.splitter, 'ArrowDown');
  assert.strictEqual(parseFloat(comp.style.height), maxH - 16);
  delete comp.offsetHeight;
});

test('chat switcher: open, rows, select another chat, outside click and Escape close, delete', async () => {
  // two chats: a fresh chat gets a message, then "+" starts a new one
  state.messages = [{ role: 'user', content: 'x' }];
  await T.createChat();
  state.messages.push({ role: 'user', content: 'First chat question' }, { role: 'assistant', content: 'First answer' });
  await T.saveHistory();
  const firstId = state.chatId;
  click(el.newChatBtn);
  await waitFor(() => state.chatId !== firstId, 'the new chat');
  assert.strictEqual($$('.empty').length, 1);
  assert.strictEqual(el.chatSwitchTitle.textContent, 'New chat');
  const menu = el.chatMenu;
  click(el.chatSwitchBtn);
  assert.ok(!menu.classList.contains('hidden'));
  assert.strictEqual(el.chatSwitchBtn.getAttribute('aria-expanded'), 'true');
  const rows = () => [...menu.querySelectorAll('.chat-row')];
  assert.ok(rows().length >= 2);
  assert.ok(rows()[0].classList.contains('active'));
  const row = rows().find((r) => r.dataset.id === firstId);
  assert.strictEqual(row.querySelector('.chat-row-title').textContent, 'First chat question');
  click(row.querySelector('.chat-row-title'));
  await waitFor(() => state.chatId === firstId, 'the switch');
  assert.ok(menu.classList.contains('hidden'));
  assert.strictEqual(el.chatSwitchBtn.getAttribute('aria-expanded'), 'false');
  assert.strictEqual(el.chatSwitchTitle.textContent, 'First chat question');
  assert.deepStrictEqual($$('.msg').map((m) => m.className.replace(' has-rail', '')), ['msg user', 'msg assistant']);
  // outside mousedown closes; a mousedown inside does not
  click(el.chatSwitchBtn);
  mouse(rows()[0], 'mousedown');
  assert.ok(!menu.classList.contains('hidden'));
  mouse(el.chat, 'mousedown');
  assert.ok(menu.classList.contains('hidden'));
  click(el.chatSwitchBtn);
  key(document.body, 'Escape');
  assert.ok(menu.classList.contains('hidden'));
  // the keyboard: ArrowDown + Enter picks the next chat
  click(el.chatSwitchBtn);
  const at = rows().findIndex((r) => r.classList.contains('active'));
  assert.ok(rows()[at].classList.contains('focused')); // the focus starts on the active chat
  const next = (at + 1) % rows().length;
  const second = rows()[next].dataset.id;
  key(document.body, 'ArrowDown');
  assert.ok(rows()[next].classList.contains('focused'));
  key(document.body, 'Enter');
  await waitFor(() => state.chatId === second, 'the keyboard switch');
  // delete the active chat from the menu: another one becomes active, the menu stays open
  click(el.chatSwitchBtn);
  const n = rows().length;
  click(rows().find((r) => r.dataset.id === second).querySelector('button[data-del]'));
  await waitFor(() => state.chatId !== second, 'the deletion');
  assert.strictEqual(rows().length, n - 1);
  assert.ok(!rows().some((r) => r.dataset.id === second));
  assert.ok(!menu.classList.contains('hidden'));
  key(document.body, 'Escape');
});

test('a running turn: the mode button and the chat buttons are disabled, one live bubble, sane DOM afterwards', async () => {
  state.settings.provider = 'anthropic';
  Object.assign(state.settings.providers.anthropic, { apiKey: 'sk-ant-test', model: 'claude-opus-5-5' });
  state.applyMode = 'auto'; T.applyApplyMode('auto');
  await T.createChat();
  const stream = liveStream();
  env.ctx.fetch = async () => stream.response;
  typeInto(el.input, 'Explain it');
  key(el.input, 'Enter');
  await waitFor(() => state.busy && stream.reads > 0, 'the request');
  assert.ok(el.modeCycle.disabled && el.newChatBtn.disabled && el.chatSwitchBtn.disabled);
  assert.ok(el.action.classList.contains('stopping'));
  click(el.modeCycle); // ignored while busy: no menu
  assert.ok(el.modeMenu.classList.contains('hidden'));
  assert.strictEqual(state.applyMode, 'auto');
  assert.strictEqual(el.modeLabel.textContent, 'Auto');
  click(el.chatSwitchBtn);
  assert.ok(el.chatMenu.classList.contains('hidden'));
  assert.strictEqual($$('.msg.user').length, 1);
  assert.strictEqual(el.input.value, '');
  stream.push(ev('message_start', { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 10 } } }) +
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
  const delta = (t) => ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } });
  stream.push(delta('Hello '));
  await waitFor(() => $$('.msg.assistant').length === 1 && $$('.msg.assistant .md')[0].textContent === 'Hello ', 'the first frame');
  let live = $$('.msg.assistant')[0];
  assert.ok(live.classList.contains('typing'));
  assert.strictEqual(live.querySelector('button[data-act$="-code"]'), null); // no buttons while streaming
  stream.push(delta('**world**'));
  await waitFor(() => live.querySelector('.md strong') && live.querySelector('.md strong').textContent === 'world', 'the second frame');
  stream.push(delta('\n\n- item'));
  await waitFor(() => live.querySelector('.md li'), 'the list');
  assert.strictEqual($$('.msg.assistant').length, 1); // updated in place, never duplicated
  assert.strictEqual(live.querySelectorAll('.md').length, 1);
  stream.push(ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }) + ev('message_stop', { type: 'message_stop' }));
  stream.end();
  await waitFor(() => !state.busy, 'the end of the turn');
  await tick(10);
  assert.deepStrictEqual($$('#chat > *', document).map((m) => m.className.replace(' has-rail', '')), ['msg user', 'msg assistant']);
  live = $$('.msg.assistant')[0];
  assert.ok(!live.classList.contains('typing'));
  assert.strictEqual(live.querySelector('.md').innerHTML, '<p>Hello <strong>world</strong></p><ul><li>item</li></ul>');
  assert.strictEqual(live.querySelector('button[data-act$="-code"]'), null); // a plain answer: no Insert / Copy
  assert.strictEqual(live.querySelector('.msg-meta').textContent, '14 tokens');
  assert.ok(!el.modeCycle.disabled && !el.newChatBtn.disabled && !el.chatSwitchBtn.disabled);
  assert.strictEqual(state.messages[state.messages.length - 1].content, 'Hello **world**\n\n- item');
  // idle: a pick in the mode menu works and persists
  const pick = (mode) => { click(el.modeCycle); click(el.modeMenu.querySelector(`.mode-row[data-mode="${mode}"]`)); };
  pick('plan');
  await tick(5);
  assert.strictEqual(state.applyMode, 'plan');
  assert.strictEqual(el.modeCycle.getAttribute('aria-label'), 'Mode: Plan, click to choose');
  assert.strictEqual(el.modeLabel.textContent, 'Plan');
  assert.strictEqual(storage.muninApplyMode, 'plan');
  pick('manual');
  await tick(5);
  assert.strictEqual(state.applyMode, 'manual');
  assert.strictEqual(el.modeCycle.getAttribute('aria-label'), 'Mode: Manual, click to choose');
  assert.strictEqual(storage.muninApplyMode, 'manual');
  pick('auto');
  await tick(5);
  assert.strictEqual(state.applyMode, 'auto');
});

test('Stop during a stream keeps the partial answer once', async () => {
  const stream = liveStream();
  env.ctx.fetch = async (url, init) => {
    init.signal.addEventListener('abort', () => stream.fail(Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' })));
    return stream.response;
  };
  typeInto(el.input, 'Another one');
  click(el.action);
  await waitFor(() => state.busy && stream.reads > 0, 'the request');
  stream.push(ev('message_start', { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 10 } } }) +
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial text' } }));
  await waitFor(() => $$('.msg.assistant .md').some((m) => m.textContent === 'Partial text'), 'the partial text');
  click(el.action); // Stop
  await waitFor(() => !state.busy, 'the stop');
  await tick(10);
  const assistants = $$('.msg.assistant');
  assert.strictEqual(assistants.filter((b) => b.textContent.includes('Partial text')).length, 1);
  assert.ok(assistants.every((b) => !b.classList.contains('typing')));
  assert.ok($$('.msg.assistant .thinking-label').some((n) => n.textContent.startsWith('Stopped after '))); // the label says it
  assert.strictEqual($$('.notice, .msg.chat-row').length, 0);
  assert.strictEqual(state.messages[state.messages.length - 1].content, 'Partial text');
});

test('header raven: in the Docs page overlay a click sends COLLAPSE_PANEL to the host tab; elsewhere it is disabled', async () => {
  // the shared panel is not embedded in a tab: the raven is a plain, disabled picture
  assert.strictEqual(el.collapseBtn.disabled, true);
  assert.ok(el.collapseBtn.contains(el.brandLogo));
  const overlay = await load({ hash: '#tabId=7' });
  try {
    const sent = [];
    overlay.chrome.tabs.sendMessage = async (id, msg) => { sent.push([id, msg]); return { ok: true, open: false }; };
    const btn = overlay.el.collapseBtn;
    assert.strictEqual(btn.tagName, 'BUTTON');
    assert.strictEqual(btn.disabled, false);
    assert.strictEqual(btn.dataset.tip, undefined); // no tooltip: the raven is obvious
    assert.strictEqual(btn.getAttribute('aria-label'), 'Hide the panel');
    assert.ok(btn.contains(overlay.el.brandLogo));
    click(btn);
    await tick(5);
    assert.deepStrictEqual(sent.filter(([, m]) => m.type === 'COLLAPSE_PANEL').map(([id, m]) => [id, JSON.stringify(m)]),
      [[7, '{"type":"COLLAPSE_PANEL"}']]);
  } finally { overlay.close(); }
});
