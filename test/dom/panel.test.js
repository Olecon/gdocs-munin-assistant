'use strict';
// The panel on a real DOM (jsdom): the click delegation of #chat (Copy, Apply to selection, Undo, Allow /
// Deny of open_document, Revert of remember), the instructions limit, the settings form, the Auto/Manual switch while busy,
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

test('#chat delegation: Copy (message, code block; also from the inner icon), check mark, copy failure', async () => {
  state.messages = answerHistory();
  T.renderHistory();
  const bubbles = $$('.msg.assistant');
  assert.strictEqual(bubbles.length, 1);
  const b = bubbles[0];
  const copyMsg = b.querySelector('.msg-actions button[data-act="copy-msg"]');
  click(copyMsg.querySelector('svg path')); // a click on the icon bubbles to the button
  await tick(5);
  assert.deepStrictEqual(env.clipboard.writes, [answerHistory()[1].content]);
  assert.ok(copyMsg.classList.contains('done'));
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
  click(copyMsg); await tick(5);
  assert.ok($$('.msg.error').some((e) => e.textContent === 'Could not copy: denied'));
  env.clipboard.fail = null;
});

test('#chat delegation: Apply to selection (message and code block), success and paste failure', async () => {
  state.messages = answerHistory();
  T.renderHistory();
  tabMsgs.length = 0;
  const b = $$('.msg.assistant')[0];
  click(b.querySelector('.code-bar button[data-act="apply-code"]'));
  await waitFor(() => $$('.tool-card').length === 1, 'the result card');
  assert.deepStrictEqual(tabMsgs.filter((m) => m.type === 'REPLACE_SELECTION').map((m) => m.text), ['print(1)']);
  const card = $$('.tool-card')[0];
  assert.ok(card.classList.contains('ok'));
  assert.strictEqual(card.firstElementChild.textContent, '✅ Replaced in document');
  assert.strictEqual(card.querySelector('details pre').textContent, 'print(1)');
  // the paste fails: the text goes to the clipboard and the card says so
  const prevSend = chrome.tabs.sendMessage;
  chrome.tabs.sendMessage = async (id, msg) => (msg.type === 'REPLACE_SELECTION' ? { ok: false, error: 'paste event not handled' } : prevSend(id, msg));
  const applyMsg = b.querySelector('.msg-actions button[data-act="apply-msg"]');
  click(applyMsg);
  assert.strictEqual(applyMsg.disabled, true); // while it runs
  await waitFor(() => $$('.tool-card').length === 2, 'the failure card');
  assert.strictEqual(applyMsg.disabled, false);
  const fail = $$('.tool-card')[1];
  assert.ok(fail.classList.contains('fail'));
  assert.ok(fail.textContent.includes('copied to the clipboard') && fail.textContent.includes('paste event not handled'));
  assert.strictEqual(env.clipboard.writes[env.clipboard.writes.length - 1], answerHistory()[1].content);
  chrome.tabs.sendMessage = prevSend;
});

test('#chat delegation: Undo on the card of the latest Docs API edit', async () => {
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
  const undo = $$('.tool-card button[data-act="undo-edit"]');
  assert.strictEqual(undo.length, 1);
  assert.strictEqual(undo[0].dataset.edit, 'toolu_u1');
  click(undo[0]);
  await waitFor(() => !state.undoing && $$('.msg.notice').some((n) => n.textContent.startsWith('↩️ Undid')), 'the undo');
  assert.ok(fake.text('t.0').includes('Alpha beta gamma.') && !fake.text('t.0').includes('GAMMA'));
  assert.strictEqual(state.messages[2]._edit.undone, true);
  const cards = $$('.tool-card');
  assert.strictEqual(cards.length, 1); // re-rendered, not duplicated
  assert.ok(cards[0].firstElementChild.textContent.endsWith('(undone)'));
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
  assert.ok(card.classList.contains('decided'));
  assert.strictEqual(fake2.log.length, 0);
  click(card.querySelector('button[data-act="preview-accept"]')); // a decided card: no effect
  assert.strictEqual(T.pendingPreviews.size, 0);
  // Allow: the document is read through the Docs API
  p = call('o2');
  await waitFor(() => T.pendingPreviews.size === 1, 'the second card');
  click($$('.tool-card.preview:not(.decided) button[data-act="preview-accept"]')[0]);
  r = await p;
  assert.strictEqual(r._decision, 'accepted');
  assert.ok(r._ok && r.content.startsWith('Opened as doc2. Title: "Other paper".'), r.content);
  assert.ok(fake2.log.some((x) => x.method === 'GET'));
  state.googleConnected = false;
});

test('#chat delegation: Continue and Skip of the self-test\'s Your-turn card; Stop ends the wait', async () => {
  el.chat.textContent = '';
  let p = T.confirmYourTurn('Select «brown fox», then click Continue.', null);
  let card = $$('.tool-card.your-turn')[0];
  assert.ok(card, 'the card');
  assert.deepStrictEqual([...card.querySelectorAll('button[data-act]')].map((b) => b.textContent), ['Continue', 'Skip']);
  assert.strictEqual(card.querySelector('.pv-note').textContent, 'Select «brown fox», then click Continue.');
  click(card.querySelector('button[data-act="preview-continue"]'));
  assert.strictEqual(await p, 'continue');
  assert.ok(!card.isConnected, 'removed once decided');
  assert.strictEqual(T.pendingPreviews.size, 0);
  p = T.confirmYourTurn('Make it bold.', null);
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
  const p = T.confirmYourTurn('Select «brown fox», then click Continue.', null, { showSelection: true });
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
  click(card.querySelector('button[data-act="preview-continue"]'));
  assert.strictEqual(await p, 'continue');
  assert.strictEqual(T.showYourTurnSelection('y'), false, 'no card waits');
  // without the option: no selection line
  const q = T.confirmYourTurn('Remove it.', null);
  assert.strictEqual($$('.tool-card.your-turn .pv-sees').length, 0);
  click($$('.tool-card.your-turn button[data-act="preview-skip"]')[0]);
  assert.strictEqual(await q, 'skip');
  state.selection = saved;
});

test('remember: the open section, its counter and the dot follow at once; the card\'s Revert works once and survives a re-render', async () => {
  storage['muninDocInstructions:DOC123'] = 'Use British English.';
  state.docInstructions = 'Use British English.';
  click(el.instructionsBtn);
  assert.strictEqual(el.instructionsText.value, 'Use British English.');
  const tc = { id: 'toolu_rm1', type: 'function', function: { name: 'remember', arguments: JSON.stringify({ action: 'add', text: 'Keep the term "lipid raft".' }) } };
  const sn = T.takeSnapshot(); T.snapshotDocument(sn);
  const r = await T.executeTool(tc, 'edit', sn, {});
  assert.ok(r._ok, r.content);
  const both = 'Use British English.\nKeep the term "lipid raft".';
  assert.strictEqual(el.instructionsText.value, both); // no unsaved changes: the section shows the new text
  assert.strictEqual(el.instructionsCount.textContent, `${both.length} / 8,000 characters`);
  assert.ok(!el.instructionsDot.classList.contains('hidden'));
  click(document.getElementById('closeInstructions'));
  state.messages = [
    { role: 'user', content: 'Remember: keep the term "lipid raft".' },
    { role: 'assistant', content: null, tool_calls: [tc] }, r, { role: 'assistant', content: 'Noted.' },
  ];
  T.renderHistory();
  await T.saveHistory(); // Revert starts from the stored history, like Undo
  const card = $$('.tool-card')[0];
  assert.strictEqual(card.firstElementChild.textContent, '📌 Added to Document instructions: «Keep the term "lipid raft".»');
  assert.strictEqual(card.querySelector('details'), null); // no "Inserted text" part
  const btn = card.querySelector('button[data-act="revert-remember"]');
  assert.strictEqual(btn.textContent, 'Revert'); assert.ok(!btn.disabled);
  click(btn);
  await waitFor(() => !state.undoing && storage['muninDocInstructions:DOC123'] === 'Use British English.', 'the revert');
  assert.strictEqual(state.docInstructions, 'Use British English.');
  assert.strictEqual(state.messages[2]._remember.reverted, true);
  const again = () => $$('.tool-card button[data-act="revert-remember"]');
  assert.strictEqual($$('.tool-card').length, 1); // re-rendered, not duplicated
  assert.strictEqual(again()[0].textContent, 'Reverted'); assert.ok(again()[0].disabled);
  T.renderHistory();
  assert.strictEqual(again()[0].textContent, 'Reverted'); assert.ok(again()[0].disabled);
  assert.strictEqual(await T.revertRememberFromButton('toolu_rm1', null), false); // once only
  assert.strictEqual(storage['muninDocInstructions:DOC123'], 'Use British English.');
  delete storage['muninDocInstructions:DOC123']; state.docInstructions = ''; state.messages = []; T.renderHistory();
});

test('document instructions: the textarea maxlength is the real limit and the counter matches it', () => {
  const ta = el.instructionsText;
  assert.strictEqual(ta.getAttribute('maxlength'), '8000');
  assert.strictEqual(ta.maxLength, T.DOC_INSTRUCTIONS_MAX);
  assert.ok(el.instructionsCount.textContent.includes('8,000 characters'));
  click(el.instructionsBtn);
  assert.ok(!el.instructions.classList.contains('hidden'));
  assert.strictEqual(document.activeElement, ta);
  typeInto(ta, 'x'.repeat(7999));
  assert.strictEqual(el.instructionsCount.textContent, '7,999 / 8,000 characters');
  assert.ok(!el.instructionsCount.classList.contains('warn'));
  typeInto(ta, 'x'.repeat(8000)); // the most the textarea accepts from the keyboard
  assert.strictEqual(el.instructionsCount.textContent, '8,000 / 8,000 characters');
  assert.ok(el.instructionsCount.classList.contains('warn'));
  click(document.getElementById('closeInstructions'));
  assert.ok(el.instructions.classList.contains('hidden'));
});

test('settings form: the gear toggles, a press outside closes, no Save or Close; provider, key and model apply at once', async () => {
  const btn = document.getElementById('settingsBtn');
  assert.strictEqual(document.getElementById('saveSettings'), null);
  assert.strictEqual(document.getElementById('closeSettings'), null);
  click(el.instructionsBtn); // the instructions section closes when the settings open
  click(btn);
  assert.ok(!el.settings.classList.contains('hidden'));
  assert.ok(el.instructions.classList.contains('hidden'));
  assert.strictEqual(document.activeElement, el.apiKey);
  assert.strictEqual(el.provider.value, state.settings.provider);
  pointer(btn, 'pointerdown'); click(btn); // the gear's own press does not count as outside
  assert.ok(el.settings.classList.contains('hidden'));
  click(btn);
  // presses inside the settings keep them open; outside (chat, composer, header) close them
  for (const inside of [el.settings, el.apiKey, el.provider, el.modelSelect, el.googleConnect, document.querySelector('#settings h2')]) {
    pointer(inside, 'pointerdown');
    assert.ok(!el.settings.classList.contains('hidden'), inside.id || inside.tagName);
  }
  for (const outside of [el.chat, el.input, el.modeCycle, document.querySelector('.topbar'), el.newChatBtn]) {
    if (el.settings.classList.contains('hidden')) click(btn);
    assert.ok(!el.settings.classList.contains('hidden'));
    pointer(outside, 'pointerdown');
    assert.ok(el.settings.classList.contains('hidden'), outside.id || outside.className);
  }
  click(btn);
  // the provider applies on change
  el.provider.value = 'anthropic';
  el.provider.dispatchEvent(new env.window.Event('change', { bubbles: true }));
  assert.strictEqual(el.apiKeyLabel.textContent, 'Anthropic (Claude) API key');
  assert.strictEqual(state.settings.provider, 'anthropic');
  await waitFor(() => storage.muninProvider === 'anthropic', 'the stored provider');
  assert.strictEqual(env.window.document.getElementById('effort'), null); // no Effort field (nor Base URL / Model text fields)
  const fetched = [];
  env.ctx.fetch = async (url) => { fetched.push(url); return { ok: true, status: 200, json: async () => ({ data: [{ id: 'claude-opus-5-5' }, { id: 'claude-sonnet-5-5' }] }), text: async () => '' }; };
  typeInto(el.apiKey, 'wrong-prefix');
  assert.ok(!el.keyWarn.classList.contains('hidden'));
  typeInto(el.apiKey, 'sk-ant-test');
  assert.ok(el.keyWarn.classList.contains('hidden'));
  // the key: stored after the 0.7 s pause, then checked
  await tick(300);
  assert.notStrictEqual(storage.anthropicApiKey, 'sk-ant-test');
  assert.strictEqual(fetched.length, 0);
  await waitFor(() => /^Connected to Anthropic \(Claude\): the key works\./.test(el.modelStatus.textContent), 'the key check');
  assert.strictEqual(storage.anthropicApiKey, 'sk-ant-test');
  assert.ok(!el.settings.classList.contains('hidden')); // the settings stay open
  assert.ok(fetched.every((u) => u.startsWith('https://api.anthropic.com/v1/models?limit=100'))); // paginated since feat/storage
  assert.strictEqual(storage.anthropicModel, 'claude-opus-5-5');
  // the model: stored on change
  el.modelSelect.value = 'claude-sonnet-5-5';
  el.modelSelect.dispatchEvent(new env.window.Event('change', { bubbles: true }));
  await waitFor(() => storage.anthropicModel === 'claude-sonnet-5-5', 'the stored model');
  assert.strictEqual(state.settings.providers.anthropic.model, 'claude-sonnet-5-5');
  // the key on leaving the field, before the pause
  fetched.length = 0;
  typeInto(el.apiKey, 'sk-ant-blur');
  el.apiKey.dispatchEvent(new env.window.FocusEvent('blur'));
  await waitFor(() => storage.anthropicApiKey === 'sk-ant-blur' && fetched.length, 'the key stored on blur');
  // typing and a click outside at once: stored on closing; the check reports in the chat
  typeInto(el.apiKey, 'sk-ant-away');
  pointer(el.chat, 'pointerdown');
  assert.ok(el.settings.classList.contains('hidden'));
  await waitFor(() => storage.anthropicApiKey === 'sk-ant-away', 'the key stored on closing');
  await waitFor(() => $$('.msg.notice').some((n) => n.textContent === 'Connected to Anthropic (Claude): the key works.'), 'the chat notice');
  // back to Munin for the other tests
  click(btn);
  el.provider.value = 'munin';
  el.provider.dispatchEvent(new env.window.Event('change', { bubbles: true }));
  await waitFor(() => storage.muninProvider === 'munin', 'Munin again');
  click(btn);
  assert.ok(el.settings.classList.contains('hidden'));
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
  for (const s of ['input', 'textarea', '.sel-preview', '.sel-full']) assert.ok(text.includes(s), s);
  // nothing of the chat's content is excluded
  for (const s of none) assert.ok(!/^(\.chat|#chat|\.msg|\.tool-card|\.check-report|\.selftest|body|html|\*)$/.test(s), s);
  // the elements: chrome inside the excluded containers, content outside them
  const matchesNone = (node) => none.some((s) => !s.includes(':') && node.closest(s));
  for (const node of [el.docStatus, el.modeCycle, document.querySelector('.sel-label'), document.getElementById('contextText'),
    document.querySelector('#settings h2'), el.googleStatus, el.instructionsCount]) assert.ok(matchesNone(node), node.id || node.className);
  state.messages = answerHistory(); T.renderHistory();
  const bubble = $$('.msg.assistant')[0];
  assert.ok(!matchesNone(bubble) && !matchesNone(bubble.querySelector('p') || bubble));
  assert.ok(matchesNone(bubble.querySelector('button[data-act="copy-msg"]'))); // its buttons are chrome
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
  deq([el.googleStatus.textContent, el.googleStatus.title], ['Google account', 'Not signed in']);
  assert.ok(shown(el.googleConnect) && !shown(el.googleSwitch) && !shown(el.googleDisconnect));
  assert.strictEqual(el.googleConnect.textContent, 'Sign in with Google');
  // signed in with the account's email, and without it
  state.googleConnected = true; state.googleAccount = { email: 'ann@example.com', name: 'Ann' }; T.renderGoogleStatus();
  deq([el.googleStatus.textContent, el.googleStatus.title], ['Google account', 'Signed in as ann@example.com']);
  assert.ok(!shown(el.googleConnect) && shown(el.googleSwitch) && shown(el.googleDisconnect));
  deq([el.googleSwitch.textContent, el.googleDisconnect.textContent], ['Switch account', 'Sign out']);
  state.googleAccount = null; T.renderGoogleStatus();
  assert.strictEqual(el.googleStatus.title, 'Signed in');
  // the button: the account chooser, then the userinfo request
  state.googleConnected = false; T.renderGoogleStatus();
  ident.calls.length = 0;
  env.ctx.fetch = async (url, init) => (url === 'https://openidconnect.googleapis.com/v1/userinfo'
    ? { ok: true, status: 200, json: async () => ({ email: 'bob@example.com' }) } : was.fetch(url, init));
  click(el.googleConnect);
  await waitFor(() => el.googleStatus.title === 'Signed in as bob@example.com', 'the signed-in tooltip');
  deq(ident.calls, [true]);
  assert.ok(shown(el.googleSwitch) && !shown(el.googleConnect));
  click(el.googleDisconnect);
  await waitFor(() => el.googleStatus.title === 'Not signed in', 'the tooltip after Sign out');
  assert.ok(shown(el.googleConnect) && !shown(el.googleSwitch) && !shown(el.googleDisconnect));
  click(document.getElementById('settingsBtn'));
  delete storage.muninGoogleAccount;
  Object.assign(state, { googleConnected: was.connected, googleAccount: was.account }); env.ctx.fetch = was.fetch;
});

test('document instructions: no Save; saved after a 1 s pause, on leaving the field and on closing; the counter follows', async () => {
  const key = 'muninDocInstructions:DOC123';
  delete storage[key]; state.docInstructions = '';
  assert.strictEqual(document.getElementById('saveInstructions'), null);
  click(el.instructionsBtn);
  typeInto(el.instructionsText, 'Use British English.');
  assert.strictEqual(el.instructionsCount.textContent, '20 / 8,000 characters');
  await tick(500);
  assert.ok(!(key in storage)); // still typing
  await waitFor(() => storage[key] === 'Use British English.', 'the save after the pause');
  assert.strictEqual(state.docInstructions, 'Use British English.');
  assert.ok(!el.instructionsDot.classList.contains('hidden'));
  assert.ok(!el.instructions.classList.contains('hidden')); // stays open
  typeInto(el.instructionsText, 'Use British English.\nTarget: Nature.');
  el.instructionsText.dispatchEvent(new env.window.FocusEvent('blur'));
  await waitFor(() => storage[key] === 'Use British English.\nTarget: Nature.', 'the save on blur');
  typeInto(el.instructionsText, 'Keep it short.');
  click(document.getElementById('closeInstructions'));
  assert.ok(el.instructions.classList.contains('hidden'));
  await waitFor(() => storage[key] === 'Keep it short.', 'the save on closing');
  click(el.instructionsBtn);
  typeInto(el.instructionsText, '');
  click(document.getElementById('settingsBtn')); // opening the settings closes the section: saved too
  await waitFor(() => !(key in storage), 'the empty text removes the key');
  await tick(5);
  assert.ok(el.instructionsDot.classList.contains('hidden'));
  click(document.getElementById('settingsBtn'));
  assert.ok(!$$('.msg.notice').some((n) => /Document instructions (saved|removed)/.test(n.textContent))); // no notices
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
  assert.deepStrictEqual(rows().map((r) => r.querySelector('.cmd-name').textContent), ['/research', '/code', '/chat', '/review', '/side', '/check', '/test']);
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
  assert.ok(card.classList.contains('selftest') && card.classList.contains('notice'));
  assert.strictEqual(card.querySelectorAll('.st-row').length, 2);
  assert.strictEqual(card.querySelector('details.st-row pre').textContent, 'line one\nline two');
  assert.ok(card.querySelector('.st-hint').textContent.includes('Send this report to the developer'));
  assert.strictEqual(card.querySelector('.st-summary').textContent, '1 passed, 0 warnings, 1 failed, 0 skipped');
  env.clipboard.writes.length = 0;
  click(card.querySelector('button[data-act="copy-selftest"]'));
  await tick(5);
  assert.strictEqual(env.clipboard.writes.length, 1);
  assert.strictEqual(env.clipboard.writes[0], T.selfTestMarkdown(report));
  assert.ok(env.clipboard.writes[0].includes('| 2 | Export read | ❌ fail | 2 ms | download disabled |'));
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
  assert.deepStrictEqual($$('.msg').map((m) => m.className), ['msg user', 'msg assistant']);
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
  assert.strictEqual(el.modeLabel.textContent, 'Edit automatically');
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
  assert.ok(live.querySelector('.msg-actions').classList.contains('hidden')); // no buttons while streaming
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
  assert.deepStrictEqual($$('#chat > *', document).map((m) => m.className), ['msg user', 'msg assistant']);
  live = $$('.msg.assistant')[0];
  assert.ok(!live.classList.contains('typing'));
  assert.strictEqual(live.querySelector('.md').innerHTML, '<p>Hello <strong>world</strong></p><ul><li>item</li></ul>');
  assert.ok(!live.querySelector('.msg-actions').classList.contains('hidden'));
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
  assert.ok($$('.msg.notice').some((n) => n.textContent === 'Stopped.'));
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
    assert.strictEqual(btn.title, 'Hide the panel');
    assert.strictEqual(btn.getAttribute('aria-label'), 'Hide the panel');
    assert.ok(btn.contains(overlay.el.brandLogo));
    click(btn);
    await tick(5);
    assert.deepStrictEqual(sent.filter(([, m]) => m.type === 'COLLAPSE_PANEL').map(([id, m]) => [id, JSON.stringify(m)]),
      [[7, '{"type":"COLLAPSE_PANEL"}']]);
  } finally { overlay.close(); }
});
