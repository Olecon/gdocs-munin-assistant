'use strict';
// The /review card on a real DOM: it replaces the answer's text after the turn and again after every re-render; the
// findings by group; line links that call scrollToLine only on click (plain text without it, and for unverified
// quotes); Copy copies the Markdown; Fix flagged explains why it is off, then sends one message through the Send path
// (or queues it while an answer runs).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { load, click, tick } = require('../lib/dom-sandbox');
const { installDocTab } = require('../lib/sandbox');
const { recordFetch, useProvider, send, muText } = require('../lib/context');

let env, T, state, el, chrome;
const DOC = '# Fatigue trial\n\nThe treatment cures fatigue in all patients.\n\n## Results\n\nFatigue scores fell by 12% (Table 1).';
const ANSWER = '```json\n{"criteria":{"claims":"FAIL"},"findings":[{"severity":"major","criterion":"claims","quote":"The treatment cures fatigue","line":1,"detail":"Too strong.","action":"Say reduced."},' +
  '{"criterion":"support","quote":"fatigue in all patients","line":3,"status":"supported","evidence":{"quote":"Fatigue scores fell by 12%","line":7}},' +
  '{"severity":"critical","criterion":"terms","quote":"a sentence that is not there","line":2,"detail":"x"}]}\n```';
const card = () => { const b = [...el.chat.querySelectorAll('.msg.assistant')].pop(); return b && b.querySelector('.findings-card'); };

before(async () => {
  env = await load();
  ({ T, state, el, chrome } = env);
  installDocTab(env);
  chrome.tabs.sendMessage = async (id, msg) => {
    switch (msg.type) {
      case 'PING': return { ok: true, title: 'My Doc' };
      case 'GET_SELECTION': return { ok: true, text: '' };
      case 'GET_DOC_TEXT': return { ok: true, text: DOC, format: 'markdown', title: 'My Doc' };
      default: return { ok: true };
    }
  };
  await T.refreshContext({ force: true });
  useProvider(env, 'munin');
  state.applyMode = 'manual';
  env.window.scrollToLine = (line, text) => { env.scrolled.push([line, text]); };
  env.scrolled = [];
});
after(() => env.close());

test('the card replaces the review text, with groups, line links, the unverified note and Copy', async () => {
  await T.createChat();
  recordFetch(env, [muText(ANSWER)]);
  await send(env, '/review all of it');
  await tick(5);
  const bubble = [...el.chat.querySelectorAll('.msg.assistant')].pop();
  const c = card();
  assert.ok(c, 'the card is in the answer');
  assert.ok(bubble.querySelector('.md').classList.contains('hidden') && bubble.querySelector('.msg-actions').classList.contains('hidden'));
  assert.strictEqual(c.querySelector('.st-head').textContent, '📋 Review');
  assert.strictEqual(c.querySelector('.st-sub').textContent, '1 major, 1 supported, 1 unverified');
  assert.strictEqual(c.querySelector('.finding-criteria').textContent, 'Claims vs evidence: FAIL');
  const rows = [...c.querySelectorAll('.finding')];
  assert.deepStrictEqual(rows.map((r) => r.className.match(/finding-(\w+)/)[1]), ['major', 'ok', 'unverified']);
  // the major one: its real line (3, not the claimed 1) as a link; nothing scrolls before the click
  const link = rows[0].querySelector('button.finding-line');
  assert.strictEqual(link.textContent, 'line 3');
  assert.deepStrictEqual(env.scrolled, []);
  click(link);
  assert.deepStrictEqual(env.scrolled, [[3, 'The treatment cures fatigue']]);
  assert.strictEqual(rows[0].querySelector('.finding-quote').textContent, '«The treatment cures fatigue»');
  assert.strictEqual(rows[0].querySelector('.finding-action').textContent, 'Fix: Say reduced.');
  // the supported claim shows what it was checked against, with its own link
  assert.ok(rows[1].querySelector('.finding-evidence').textContent.startsWith('Checked against line 7'));
  // the unverified one: no link, the note
  assert.strictEqual(rows[2].querySelector('button.finding-line'), null);
  assert.strictEqual(rows[2].querySelector('.finding-line').textContent, 'line 2?');
  assert.strictEqual(rows[2].querySelector('.finding-note').textContent, 'unverified: quote not found');
  // Copy: the Markdown that the chat stores
  click(c.querySelector('button[data-act="copy-msg"]'));
  await tick(5);
  assert.deepStrictEqual(env.clipboard.writes.slice(-1), [state.messages[state.messages.length - 1].content]);
  assert.ok(env.clipboard.writes.slice(-1)[0].startsWith('**Review**: 1 major'));
});

test('a re-render (and a reload of the chat) puts the card back; without scrollToLine the line is plain text', async () => {
  T.renderHistory();
  await tick(5);
  assert.ok(card());
  state.messages = JSON.parse(JSON.stringify(env.storage['muninChatHistory:DOC123:' + state.chatId])); // as read back from storage
  T.renderHistory();
  await tick(5);
  assert.strictEqual(card().querySelectorAll('.finding').length, 3);
  const keep = env.window.scrollToLine;
  env.window.scrollToLine = undefined; // a global function declaration cannot be deleted; undefined is enough for the typeof guard
  try {
    T.renderHistory();
    await tick(5);
    const line = card().querySelector('.finding-major .finding-line');
    assert.strictEqual(line.tagName, 'SPAN');
    assert.strictEqual(line.textContent, 'line 3');
  } finally {
    env.window.scrollToLine = keep;
  }
});

test('Fix flagged: off in Manual (the reason shows), then one message through the Send path; queued while busy', async () => {
  T.renderHistory();
  await tick(5);
  const btn = card().querySelector('button.review-fix');
  const hint = card().querySelector('.review-fix-hint');
  assert.strictEqual(btn.textContent, 'Fix flagged (1)');
  assert.ok(btn.classList.contains('off'));
  assert.strictEqual(hint.textContent, 'Fix flagged edits the document: switch to Edit automatically first.');
  const sent = [];
  const realSend = env.window.sendMessage;
  env.window.sendMessage = async (q) => { sent.push(q); };
  try {
    click(btn);
    assert.deepStrictEqual(sent, []);
    Object.assign(state, { applyMode: 'auto', googleConnected: false, docFormat: 'markdown' });
    click(btn);
    assert.strictEqual(hint.textContent, 'Fix flagged needs the Google Docs API: sign in with Google in Settings.');
    assert.deepStrictEqual(sent, []);
    Object.assign(state, { googleConnected: true, docFormat: 'docs-api' });
    click(btn);
    await tick(2);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].text, 'Fix the flagged findings:\n1. Line 3, «The treatment cures fatigue»: Too strong. Fix: Say reduced.\n' +
      'Change only those places, one edit per finding; keep every number and citation.');
    assert.deepStrictEqual([sent[0].docId, sent[0].chatId], [state.docId, state.chatId]);
    assert.ok(hint.classList.contains('hidden'));
    assert.ok(btn.disabled && btn.textContent === 'Sent');
    // while an answer runs: queued like a message typed then
    T.renderHistory();
    await tick(5);
    state.busy = true;
    click(card().querySelector('button.review-fix'));
    assert.strictEqual(sent.length, 1);
    assert.ok(state.queued && state.queued.text.startsWith('Fix the flagged findings:'));
  } finally {
    env.window.sendMessage = realSend;
    state.busy = false;
    state.queued = null;
    Object.assign(state, { applyMode: 'manual', googleConnected: false, docFormat: 'markdown' });
  }
});
