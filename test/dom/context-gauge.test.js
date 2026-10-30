'use strict';
// The context gauge in the composer bar (renderContextGauge in src/render.js): measured from the last
// request's usage, estimated like the compaction check otherwise, warning tint near the compaction point,
// hidden on an empty chat, the provider's window after Save; and the compaction boundary rows (summary vs
// fold), also after a reload from storage.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { load, click, tick } = require('../lib/dom-sandbox');
const { installDocTab, waitFor } = require('../lib/sandbox');

let env, T, state, el, document, PROVIDERS;
const gauge = () => document.getElementById('contextGauge');
const shown = () => !gauge().classList.contains('hidden');
const text = () => document.getElementById('contextText').textContent;
const MUNIN_COMPACT_AT = 65536 - 8192 - 2000; // contextTokens - maxTokens - EDIT_SAFETY_TOKENS

function installTab(e) {
  installDocTab(e);
  e.chrome.tabs.sendMessage = async (id, msg) => {
    if (msg.type === 'GET_DOC_TEXT') return { ok: true, text: '# My Doc\n\nThe quick brown fox.', format: 'markdown', title: 'My Doc' };
    if (msg.type === 'GET_SELECTION') return { ok: true, text: '' };
    return { ok: true, title: 'My Doc' };
  };
}

before(async () => {
  env = await load();
  ({ T, state, el, document, PROVIDERS } = env);
  installTab(env);
  await T.refreshContext({ force: true });
  state.settings.provider = 'munin';
  state.applyMode = 'auto';
});
after(() => env.close());

const show = (messages) => { state.messages = messages; T.renderHistory(); };
const turn = (usage) => [
  { role: 'user', content: 'Shorten the intro' },
  { role: 'assistant', content: 'Done.', ...(usage ? { _usage: usage } : {}) },
];
// The compaction check's own estimate of the next request (src/compaction.js requestTokens).
const compactionEstimate = (mode = 'edit') => env.run(`(() => {
  const snap = takeSnapshot(); snapshotDocument(snap);
  return requestTokens(${JSON.stringify(mode)}, snap, activeHistory(state.messages));
})()`);

test('empty chat: the gauge is hidden; it appears with the first turn', () => {
  show([]);
  assert.ok(!shown());
  show(turn({ prompt_tokens: 900, completion_tokens: 20, total_tokens: 920 }));
  assert.ok(shown());
  show([]);
  assert.ok(!shown());
});

test('measured: the last request\'s usage (prompt + reply) against the context window', () => {
  show(turn({ prompt_tokens: 40000, completion_tokens: 1200, total_tokens: 41200 }));
  assert.strictEqual(text(), 'Context 41k / 66k');
  // role="img" hides the children from screen readers: the numbers are read from the label.
  assert.strictEqual(gauge().getAttribute('aria-label'), 'Context: 41,200 of 65,536 tokens');
  assert.ok(!gauge().classList.contains('estimated'));
  assert.ok(!gauge().classList.contains('warn'));
  assert.ok(gauge().title.startsWith('Last request: 41,200 tokens, measured by the provider (prompt 40,000 + reply 1,200).'), gauge().title);
  assert.ok(gauge().title.includes('Munin context window: 65,536 tokens.'));
  assert.ok(gauge().title.includes(`compacted when a request is estimated above ${MUNIN_COMPACT_AT.toLocaleString('en-US')} tokens (next request now: about`));
  assert.strictEqual(document.getElementById('contextFill').style.width, `${(41200 / 65536 * 100).toFixed(1)}%`);
  assert.strictEqual(document.getElementById('contextMark').style.left, `${(MUNIN_COMPACT_AT / 65536 * 100).toFixed(1)}%`);
  // the last round of the turn counts, not the first one
  show([
    { role: 'user', content: 'Fix it' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_outline', arguments: '{}' } }], _usage: { prompt_tokens: 5000, completion_tokens: 10 } },
    { role: 'tool', tool_call_id: 'c1', content: 'L1: # My Doc' },
    { role: 'assistant', content: 'Fixed.', _usage: { prompt_tokens: 5600, completion_tokens: 30 } },
  ]);
  assert.strictEqual(text(), 'Context 5.6k / 66k');
});

test('estimated: no usage in the latest turn; the same estimate as the compaction check', async () => {
  show(turn(null));
  const est = compactionEstimate();
  assert.ok(est > 1000);
  assert.ok(gauge().classList.contains('estimated'));
  assert.ok(text().startsWith('Context ~'), text());
  assert.ok(gauge().title.startsWith(`Next request: about ${est.toLocaleString('en-US')} tokens, estimated from this chat`), gauge().title);
  // a usage of an earlier turn is not the latest request: the failed newest turn is estimated
  show([...turn({ prompt_tokens: 3000, completion_tokens: 5 }), { role: 'user', content: 'And now?' }]);
  assert.ok(gauge().classList.contains('estimated'));
  assert.strictEqual(gauge().title.split(' tokens')[0], `Next request: about ${compactionEstimate().toLocaleString('en-US')}`);
  // Plan and Manual offer fewer tools: a pick in the mode menu updates the estimate (Edit automatically -> Plan -> Manual -> back)
  const pick = (mode) => { click(el.modeCycle); click(el.modeMenu.querySelector(`.mode-row[data-mode="${mode}"]`)); };
  const auto = compactionEstimate('edit');
  pick('plan');
  await tick(5);
  assert.strictEqual(state.applyMode, 'plan');
  assert.ok(gauge().title.startsWith(`Next request: about ${compactionEstimate('plan').toLocaleString('en-US')} tokens`));
  assert.ok(compactionEstimate('plan') < auto);
  pick('manual');
  await tick(5);
  assert.strictEqual(state.applyMode, 'manual');
  assert.ok(gauge().title.startsWith(`Next request: about ${compactionEstimate('manual').toLocaleString('en-US')} tokens`));
  assert.ok(compactionEstimate('manual') < auto);
  pick('auto');
  await tick(5);
});

test('warning tint near the compaction point (measured or estimated)', () => {
  const near = Math.ceil(0.8 * MUNIN_COMPACT_AT);
  show(turn({ prompt_tokens: near, completion_tokens: 0 }));
  assert.ok(gauge().classList.contains('warn'));
  show(turn({ prompt_tokens: near - 2000, completion_tokens: 0 }));
  assert.ok(!gauge().classList.contains('warn'));
  // the estimate counts too: compaction is decided on it
  show([{ role: 'user', content: 'x'.repeat(3 * near) }, { role: 'assistant', content: 'ok', _usage: { prompt_tokens: 1000, completion_tokens: 1 } }]);
  assert.strictEqual(text(), 'Context 1k / 66k');
  assert.ok(gauge().classList.contains('warn'));
});

test('provider switch in the settings (applied at once): the window and the compaction point follow', async () => {
  show(turn({ prompt_tokens: 70000, completion_tokens: 500 }));
  assert.strictEqual(text(), 'Context 71k / 66k');
  click(document.getElementById('settingsBtn'));
  env.ctx.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'claude-opus-5-5' }] }), text: async () => '' });
  el.provider.value = 'anthropic';
  el.provider.dispatchEvent(new env.window.Event('change', { bubbles: true }));
  await waitFor(() => text() === 'Context 71k / 200k', 'the gauge after the switch');
  click(document.getElementById('settingsBtn'));
  assert.strictEqual(state.settings.provider, 'anthropic');
  assert.ok(gauge().title.includes('Anthropic (Claude) context window: 200,000 tokens.'));
  assert.ok(gauge().title.includes('compacted when a request is estimated above 80,000 tokens'));
  assert.ok(gauge().classList.contains('warn')); // 70.5k >= 0.8 x 80k
  assert.strictEqual(document.getElementById('contextMark').style.left, '40%'); // 80k of 200k
  state.settings.provider = 'munin';
  T.renderHistory();
  assert.strictEqual(text(), 'Context 71k / 66k');
  assert.strictEqual(PROVIDERS.munin.contextTokens, 65536);
});

const SUMMARY_MSG = { role: 'user', content: '[Summary of the earlier conversation]\nThe user wants a shorter paper.', _summary: true, _covers: 4 };
const foldMsg = (C) => ({ role: 'user', content: `${C.SUMMARY_PREFIX}\n${C.FOLD_NOTE}\n\nUser: Fix the typo\n[replace_text(old_text="Teh", new_text="The"): ok]\nAssistant: Fixed.`, _summary: true, _folded: true, _covers: 3 });

test('compaction boundary: summary and fold rows differ; the text stays inspectable', () => {
  const C = { SUMMARY_PREFIX: T.SUMMARY_PREFIX, FOLD_NOTE: T.FOLD_NOTE };
  show([{ ...SUMMARY_MSG, _compacted: true }, foldMsg(C), ...turn(null)]);
  const rows = [...el.chat.querySelectorAll('details.summary-divider')];
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].querySelector('summary').textContent, 'Earlier conversation summarized · 4 messages');
  assert.ok(!rows[0].classList.contains('folded') && rows[0].classList.contains('compacted'));
  assert.strictEqual(rows[0].querySelector('.summary-text').textContent, 'The user wants a shorter paper.');
  assert.ok(rows[0].title.includes('summarized by the model'));
  assert.strictEqual(rows[1].querySelector('summary').textContent, 'Earlier conversation condensed · 3 messages');
  assert.ok(rows[1].classList.contains('folded'));
  // the fold's lines are shown; its format note (meant for the model) is not
  assert.strictEqual(rows[1].querySelector('.summary-text').textContent, 'User: Fix the typo\n[replace_text(old_text="Teh", new_text="The"): ok]\nAssistant: Fixed.');
  assert.ok(rows[1].title.includes('condensed'));
  click(rows[1].querySelector('summary'));
  assert.ok(rows[1].open);
});

test('after a reload: the boundary rows and the gauge come back from the stored chat', async () => {
  const C = { SUMMARY_PREFIX: T.SUMMARY_PREFIX, FOLD_NOTE: T.FOLD_NOTE };
  const now = Date.now();
  const history = [
    { role: 'user', content: 'Old question', _compacted: true }, { role: 'assistant', content: 'Old answer', _compacted: true },
    { ...SUMMARY_MSG, _covers: 2, _compacted: true }, foldMsg(C),
    ...turn({ prompt_tokens: 12000, completion_tokens: 300, total_tokens: 12300 }),
  ];
  const fresh = await load({ storage: {
    'muninChats:DOC123': [{ id: 'c1', title: 'Old', createdAt: now, updatedAt: now }],
    'muninCurrentChat:DOC123': 'c1',
    'muninChatHistory:DOC123:c1': history,
  } });
  try {
    installTab(fresh);
    await fresh.T.refreshContext({ force: true });
    const doc = fresh.document;
    const labels = [...doc.querySelectorAll('#chat details.summary-divider > summary')].map((s) => s.textContent);
    assert.deepStrictEqual(labels, ['Earlier conversation summarized · 2 messages', 'Earlier conversation condensed · 3 messages']);
    assert.strictEqual(doc.querySelectorAll('#chat .msg.compacted').length, 2);
    assert.ok(!doc.getElementById('contextGauge').classList.contains('hidden'));
    assert.strictEqual(doc.getElementById('contextText').textContent, 'Context 12k / 66k');
  } finally {
    fresh.close();
  }
});
