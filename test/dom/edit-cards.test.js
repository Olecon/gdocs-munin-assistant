'use strict';
// The chat's edits and answer buttons on a real DOM (jsdom): a successful write has no card, its action-log row reads
// "<tool> · Done · <preview>" in the row colour with Undo at its right end and the details in a fold that opens on a
// click; a failed or refused write has no card: its failed row (the round's dot red) holds the result in its fold; no
// emoji anywhere in cards, rows and notices. Apply / Copy sit in the answer's top right corner, shown on hover or focus, at 0.75 of the icon size; the
// composer bar names the chat's model; the chat provider follows the first key entered.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { load, click, tick } = require('../lib/dom-sandbox');

let env, T, state, el, document;
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{23E9}-\u{23FA}]|\u{FE0F}/u;
const css = fs.readFileSync(path.join(__dirname, '..', '..', 'sidepanel.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const ruleBody = (sel) => {
  const m = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].find((r) => r[1].split(',').map((x) => x.trim()).includes(sel));
  return m ? m[2] : '';
};
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const INSERTED = 'Yushin I. I., Golyshev V. M., Baranovskaya E. E., Petrova A. A., Smirnov B. B. Membrane order in yeast. J. Lipids 14: 210–219.';

before(async () => {
  env = await load();
  ({ T, state, el, document } = env);
});
after(() => env.close());

// A turn with a read, an applied insert (the latest edit: Undo), a failed edit and the answer.
function turnHistory() {
  const ins = call('t_ins', 'insert_after_line', { line: 3, text: INSERTED });
  const bad = call('t_bad', 'delete_lines', { start: 90, end: 91 });
  const read = call('t_read', 'read_lines', { start: 1, end: 3 });
  return [
    { role: 'user', content: 'Add the reference after line 3.' },
    { role: 'assistant', content: null, tool_calls: [read, ins, bad] },
    { role: 'tool', tool_call_id: 't_read', content: 'Lines 1-3 of 9:\n1: A\n2: B\n3: C', _ok: true, _reading: true },
    { role: 'tool', tool_call_id: 't_ins', content: 'Done: inserted after line 3; now line 4; the document has 10 lines.', _ok: true,
      _message: 'Inserted after line 3', _cardText: INSERTED, _cardLabel: 'Inserted text', _edit: { id: 't_ins', kind: 'insert', index: 9, text: '\n' + INSERTED, restore: '', paras: [], undone: false } },
    { role: 'tool', tool_call_id: 't_bad', content: 'Error: start and end must be integers with 1 <= start <= end <= 10', _ok: false, _message: 'delete_lines: invalid range' },
    { role: 'assistant', content: '' },
  ];
}

test('a successful write is its action-log row: tool, status word and a clipped preview; no green card', async () => {
  state.googleConnected = true;
  state.messages = turnHistory();
  T.renderHistory();
  assert.strictEqual(el.chat.querySelector('.tool-card.ok'), null, 'no green card after a successful insert');
  assert.strictEqual(el.chat.querySelectorAll('.tool-card').length, 0); // the failed delete: its failed row; the read: the action log only
  const rows = [...el.chat.querySelectorAll('.activity-row')];
  assert.deepStrictEqual(rows.map((r) => r.querySelector('.activity-name').textContent), ['read_lines', 'insert_after_line', 'delete_lines']);
  // three calls in one round: its action row "Actions 3", collapsed; a click opens the rows (tool-group.test.js covers
  // the action rows themselves)
  const line = el.chat.querySelector('.stage-head > .stage-line');
  assert.strictEqual(line.textContent, 'Actions 3 · failed');
  assert.ok(el.chat.querySelector('.stage-rows').classList.contains('hidden'));
  click(line);
  await tick();
  assert.ok(!el.chat.querySelector('.stage-rows').classList.contains('hidden'));
  const row = rows[1];
  assert.ok(row.classList.contains('write-row') && row.tagName === 'DIV');
  const fold = row.querySelector(':scope > details.log-fold');
  assert.ok(fold && !fold.open, 'folded by default');
  const sum = fold.querySelector('summary');
  assert.strictEqual(sum.querySelector('.log-status').textContent, 'Done');
  assert.strictEqual(sum.querySelector('.mk'), null, 'no coloured dot');
  const preview = sum.querySelector('.log-preview').textContent;
  assert.ok(preview.startsWith(' · Yushin I. I., Golyshev V. M., Baranovskaya E. E.'), preview);
  const clip = preview.slice(3);
  assert.ok(clip.endsWith('…') && clip.length <= 61 && INSERTED.startsWith(clip.slice(0, -1)), clip);
  assert.strictEqual(sum.textContent, 'insert_after_line · Done' + preview);
  // Undo at the right end of the row, outside the fold: one click, also while folded
  const undo = row.querySelector(':scope > .row-acts > button.row-act[data-act="undo-edit"]');
  assert.ok(undo && undo.dataset.edit === 't_ins' && undo.textContent === '↶', undo && undo.textContent);
  assert.strictEqual(undo.dataset.tip, 'Undo this edit');
  assert.strictEqual(undo.getAttribute('aria-label'), 'Undo this edit');
  assert.strictEqual(fold.contains(undo), false);
  assert.strictEqual(row.lastElementChild, undo.parentElement);
  // the fold: what was done, the label and the full text, then the arguments and the result
  const body = fold.querySelector('.log-body');
  assert.strictEqual(body.querySelector('.log-what').textContent, 'Inserted after line 3');
  assert.deepStrictEqual([...body.querySelectorAll('.log-label')].map((x) => x.textContent), ['Inserted text', 'Arguments', 'Result (67 characters)']);
  assert.strictEqual(body.querySelector('pre.log-text').textContent, INSERTED);
  click(sum);
  await tick();
  assert.strictEqual(fold.open, true, 'a click on the row text opens the details');
  // the CSS: the neutral row colour (no green), one line with the preview clipped, the preview hidden while open,
  // Undo a small arrow in the row colour, the accent on hover, on the row's line box
  assert.match(ruleBody('.write-row'), /display: flex/);
  assert.doesNotMatch(ruleBody('.write-row'), /--ok-/);
  assert.match(ruleBody('.log-fold > summary'), /white-space: nowrap/);
  assert.match(ruleBody('.log-fold > summary'), /text-overflow: ellipsis/);
  assert.match(ruleBody('.write-row .log-fold[open] .log-preview'), /display: none/);
  assert.match(ruleBody('.row-act'), /background: none/);
  assert.match(ruleBody('.row-act'), /color: var\(--fg-2\)/);
  assert.match(ruleBody('.row-act'), /line-height: calc\(var\(--row-size\) \* var\(--row-lh\)\)/);
  assert.match(ruleBody('.row-act:hover'), /color: var\(--accent\)/);
  assert.match(ruleBody('.row-acts'), /flex: none/);
});

test('the row\'s Undo control undoes the edit (the same path as the card\'s Undo: undoFromButton)', async () => {
  const seen = [];
  const prev = env.get('undoFromButton');
  env.ctx.__seenUndo = seen;
  env.run('undoFromButton = (id, btn) => { __seenUndo.push([id, btn.dataset.act]); return Promise.resolve(true); }');
  try {
    click(el.chat.querySelector('.write-row .row-act[data-act="undo-edit"]'));
    await tick();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(seen)), [['t_ins', 'undo-edit']]); // arrays of the page's realm
  } finally { env.ctx.__prevUndo = prev; env.run('undoFromButton = __prevUndo'); }
  // once undone (renderHistory after the undo), the row says so and has no Undo
  state.messages[3]._edit.undone = true;
  T.renderHistory();
  const row = el.chat.querySelector('.write-row');
  assert.ok(row.classList.contains('undone'));
  assert.strictEqual(row.querySelector('.log-status').textContent, 'Undone');
  assert.strictEqual(row.querySelector('[data-act="undo-edit"]'), null);
  assert.strictEqual(el.chat.querySelector('.tool-card.ok'), null);
  state.messages[3]._edit.undone = false;
  T.renderHistory();
});

test('two edits in one answer: Undo and Undo all on the latest row only', () => {
  const a = call('t_a', 'replace_text', { old_text: 'Alpha', new_text: 'Omega' });
  const b = call('t_b', 'delete_lines', { start: 2, end: 2 });
  state.messages = [
    { role: 'user', content: 'Edit.' },
    { role: 'assistant', content: null, tool_calls: [a, b] },
    { role: 'tool', tool_call_id: 't_a', content: 'Done: replaced line 1.', _ok: true, _message: 'Replaced line 1', _edit: { id: 't_a', kind: 'replace', index: 1, text: 'Omega', restore: 'Alpha', paras: [], undone: false } },
    { role: 'tool', tool_call_id: 't_b', content: 'Done: deleted line 2.', _ok: true, _message: 'Deleted line 2', _cardText: 'Beta', _cardLabel: 'Deleted text', _edit: { id: 't_b', kind: 'delete', index: 7, text: '', restore: 'Beta\n', paras: [], undone: false } },
    { role: 'assistant', content: 'Done.' },
  ];
  T.renderHistory();
  const rows = [...el.chat.querySelectorAll('.write-row')];
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].querySelector('.row-acts'), null);
  assert.deepStrictEqual([...rows[1].querySelectorAll('.row-act')].map((x) => [x.dataset.act, x.textContent, x.dataset.tip]),
    [['undo-edit', '↶', 'Undo this edit'], ['undo-all', '⟲', 'Undo all 2 edits']]);
  // the round's action row carries the same controls of the latest edit
  assert.deepStrictEqual([...el.chat.querySelectorAll('.stage-head .row-act')].map((x) => [x.dataset.act, x.dataset.edit]), [['undo-edit', 't_b'], ['undo-all', 't_b']]);
  assert.strictEqual(rows[0].querySelector('.log-preview').textContent, ' · Omega'); // a replacement: the new text
  assert.ok(rows[0].querySelector('.log-body .word-diff'));
  assert.strictEqual(el.chat.querySelectorAll('.tool-card').length, 0);
});

test('a failed write has no card: its failed row, the round\'s red dot, the result (and a detail it lacks) in the fold', () => {
  state.messages = turnHistory();
  T.renderHistory();
  assert.strictEqual(el.chat.querySelector('.tool-card'), null);
  // its row: a plain log row marked failed, the tool name in the row colour, the arguments and the result in its fold
  const row = [...el.chat.querySelectorAll('.activity-row')].pop();
  assert.ok(row.classList.contains('fail') && !row.classList.contains('write-row') && row.querySelector('summary').textContent.endsWith(' · failed'));
  assert.deepStrictEqual([...row.querySelectorAll('.log-label')].map((x) => x.textContent), ['Arguments', 'Result (66 characters)']);
  assert.strictEqual(row.querySelectorAll('.log-body pre')[1].textContent, 'Error: start and end must be integers with 1 <= start <= end <= 10');
  assert.strictEqual(row.querySelector('.log-detail'), null); // no _detail
  // the round's dot is red (the stage is the timeline item), the name keeps the row colour
  const stage = row.closest('.tl-item');
  assert.ok(stage && stage.classList.contains('tl-fail'));
  assert.match(ruleBody('.tl-item.tl-fail:not(.tl-live)::before'), /background: var\(--err-fg\)/);
  for (const sel of ['.log-row.fail .activity-name', '.agent-log .activity-row.fail .activity-name', '.agent-calls .activity-row.fail .activity-name']) {
    assert.strictEqual(ruleBody(sel), '', sel);
  }
  // a write refused by a check: the reason is in the result the model got; no second copy
  const why = 'the new text drops 5 mg, (Smith, 2020). Keep them, or tell the user you removed them on purpose and call the tool again.';
  const ref = call('t_ref', 'replace_text', { old_text: 'We used 5 mg (Smith, 2020).', new_text: 'We used the drug.' });
  state.messages = [
    { role: 'user', content: 'Shorten.' },
    { role: 'assistant', content: null, tool_calls: [ref] },
    { role: 'tool', tool_call_id: 't_ref', content: 'Refused by a check: ' + why, _ok: false, _message: 'Refused by a check', _detail: why },
    { role: 'assistant', content: 'Kept them.' },
  ];
  T.renderHistory();
  assert.strictEqual(el.chat.querySelector('.tool-card'), null);
  let fold = el.chat.querySelector('.log-row.fail .log-body');
  assert.strictEqual(fold.querySelectorAll('pre')[1].textContent, 'Refused by a check: ' + why);
  assert.strictEqual(fold.querySelector('.log-detail'), null);
  assert.ok(el.chat.querySelector('.tl-item.tl-fail'));
  // a _detail the result does not carry: one muted line under the result
  state.messages[2] = { ...state.messages[2], content: 'Error: refused.', _detail: 'Closest line: 4' };
  T.renderHistory();
  fold = el.chat.querySelector('.log-row.fail .log-body');
  assert.strictEqual(fold.lastElementChild.className, 'log-detail');
  assert.strictEqual(fold.lastElementChild.textContent, 'Closest line: 4');
  assert.doesNotMatch(css.match(/\.tool-card \{[^}]*\}/)[0], /user-select: none/);
  assert.strictEqual(el.chat.querySelector('.write-row'), null);
  state.messages = turnHistory();
  T.renderHistory();
});

test('no emoji in the chat after a turn with an edit: cards, action-log rows, rows of the turn, errors, Undo all', async () => {
  T.addChatRow('Draft ended: the plan of this chat is cleared.');
  T.addError('Only the most recent edit can be undone here. Use Ctrl+Z in Google Docs for older ones.');
  const html = el.chat.innerHTML;
  assert.ok(!EMOJI.test(html), html.match(EMOJI) && html.match(EMOJI)[0]);
  assert.ok(el.chat.querySelector('.activity-row .activity-name')); // the rows are there, without icons
  // the status marks are dots in both themes: theme colours, no glyphs
  assert.match(ruleBody('.mk.ok'), /var\(--ok-fg\)/);
  assert.match(ruleBody('.mk.fail'), /var\(--err-fg\)/);
  assert.match(ruleBody('.mk.warn'), /var\(--warn-fg\)/);
  assert.ok((css.match(/--warn-fg:/g) || []).length >= 3, 'dark, light and the system light theme');
  // the permission cards: no icon in the head
  const pending = T.confirmOpen({ tool: 'replace_text', kind: 'edit', title: 'Allow this edit?', why: 'Large edit.', range: 'Line 4', excerptLabel: 'Text', excerpt: 'x' }, null, {});
  const card = [...el.chat.querySelectorAll('.tool-card.preview')].pop();
  assert.ok(card.querySelector('.pv-head').innerHTML.startsWith('<span class="pv-tool">replace_text</span>'));
  assert.ok(!EMOJI.test(card.innerHTML));
  T.decidePreview([...T.pendingPreviews.keys()].pop(), 'reject');
  assert.strictEqual(await pending, 'reject');
});

test('Insert / Copy of an edit block: one pair, in the block\'s own bar, shown on hover or focus, 0.75 of the size', () => {
  state.messages = [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: '<replacement>\nNew text.\n</replacement>\n\nTry this.' }];
  T.renderHistory();
  const b = el.chat.querySelector('.msg.assistant');
  // the block opens the answer (the owner's screenshot): its bar holds the only pair, nothing sits in the answer's corner
  assert.deepStrictEqual([...b.querySelectorAll('button[data-act="apply-code"], button[data-act="copy-code"]')].map((x) => x.dataset.act), ['apply-code', 'copy-code']);
  assert.ok(b.querySelector('.edit-block > .code-bar button[data-act="apply-code"]') && b.querySelector('.edit-block > .code-bar button[data-act="copy-code"]'));
  assert.strictEqual(b.querySelector('.msg-actions'), null);
  assert.strictEqual(b._parts.actions, undefined);
  assert.ok(!/\.msg-actions/.test(css), 'no corner rule is left');
  // nothing in the bubble is placed over the bar: the answer frame holds the text only, the footer follows in the flow
  assert.deepStrictEqual([...b.querySelector('.msg-answer').children].map((x) => x.className), ['md msg-text']);
  assert.ok(!/position: absolute/.test(ruleBody('.msg-foot')));
  // 0.75 of the 26 x 24 button and the 15 px icon
  assert.match(ruleBody('.code-bar .btn.icon'), /width: 20px; height: 18px/);
  assert.match(ruleBody('.code-bar .btn.icon svg'), /width: 11px; height: 11px/);
  // the code block's bar: the same buttons, the same size, on hover or focus of the block
  state.messages = [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'An answer.\n\n```\ncode()\n```' }];
  T.renderHistory();
  const c = el.chat.querySelector('.msg.assistant');
  assert.ok(c.querySelector('.code-bar button[data-act="apply-code"]') && c.querySelector('.code-bar button[data-act="copy-code"]'));
  assert.match(ruleBody('.code-bar .btn.icon'), /width: 20px; height: 18px/);
  assert.match(ruleBody('.code-wrap:hover .code-bar .btn.icon'), /opacity: 1/);
  assert.match(ruleBody('.code-wrap:focus-within .code-bar .btn.icon'), /opacity: 1/);
  // a Plan answer's Do it stays visible below the answer, not in the hover corner
  state.messages = [{ role: 'user', content: 'Plan it' }, { role: 'assistant', content: '1. Do X.', _plan: true }];
  T.renderHistory();
  const p = el.chat.querySelector('.msg.assistant');
  assert.ok(p.querySelector('.msg-extra button[data-act="plan-do"]') && p.querySelectorAll('button[data-act="plan-do"]').length === 1);
});

test('Insert / Copy only where a block has a bar: none on a plain answer or a plan, one pair per block', () => {
  const buttons = (content, extra = {}) => {
    state.messages = [{ role: 'user', content: 'Hi' }, { role: 'assistant', content, ...extra }];
    T.renderHistory();
    return [...el.chat.querySelectorAll('.msg.assistant button[data-act$="-code"]')].map((x) => x.dataset.act);
  };
  assert.deepStrictEqual(buttons('The section argues that membranes are ordered.'), []);
  assert.deepStrictEqual(buttons('Which reference style do you want?'), []);
  assert.deepStrictEqual(buttons('1. Shorten the abstract.', { _plan: true }), []);
  assert.deepStrictEqual(buttons('Run this:\n\n```\ncode()\n```'), ['apply-code', 'copy-code']); // a plain code block keeps its bar's
  assert.deepStrictEqual(buttons('<insertion>\nA new sentence.\n</insertion>'), ['apply-code', 'copy-code']);
  assert.deepStrictEqual(buttons('<replacement>\nBetter text.\n</replacement>'), ['apply-code', 'copy-code']);
  // a live bubble: no block (and no buttons) while it streams; the finished block brings its bar's pair, plain text none
  const b = T.addAssistantBubble();
  const pair = () => [...b.querySelectorAll('button[data-act$="-code"]')].map((x) => x.dataset.act);
  T.updateAssistantBubble(b, { text: '<replacement>\nX', streaming: true });
  assert.deepStrictEqual(pair(), []);
  T.updateAssistantBubble(b, { text: '<replacement>\nX\n</replacement>' });
  assert.deepStrictEqual(pair(), ['apply-code', 'copy-code']);
  assert.ok(b.querySelector('.edit-block .code-bar button[data-act="apply-code"]'));
  T.updateAssistantBubble(b, { text: 'Plain.' });
  assert.deepStrictEqual(pair(), []);
});

test('the composer bar names the chat\'s model (a button for the model menu); it follows the choice', async () => {
  const label = document.getElementById('chatModel');
  state.messages = []; T.renderHistory();
  assert.strictEqual(label.tagName, 'BUTTON');
  assert.strictEqual(label.getAttribute('aria-haspopup'), 'menu');
  state.settings.providers.openai.apiKey = 'sk-o'; // an OpenAI account (test/lib/legacy-settings.js)
  await T.setChatModel('openai', 'gpt-6-astra');
  assert.strictEqual(label.textContent, 'gpt-6-astra'); // shown before the first request, with the gauge hidden
  assert.strictEqual(label.dataset.tip, 'OpenAI (ChatGPT) · gpt-6-astra');
  assert.ok(document.getElementById('contextGauge').classList.contains('hidden'));
  // a second account of the type: its own name in the tooltip
  state.settings.accounts.push({ id: 'w2', type: 'openai', name: 'Work', apiKey: 'sk-w' });
  await T.setChatModel('w2', 'gpt-6-mini');
  assert.strictEqual(label.textContent, 'gpt-6-mini');
  assert.strictEqual(label.dataset.tip, 'OpenAI (ChatGPT) (Work) · gpt-6-mini');
  // an account marked down: the dot and the reason
  T.markAccountHealth('w2', Object.assign(new Error('x'), { network: true, cause: new Error('Failed to fetch') }));
  assert.ok(label.classList.contains('down'));
  assert.match(label.dataset.tip, /\nNot reachable: Failed to fetch \(checked \d/);
  T.markAccountHealth('w2', null);
  assert.ok(!label.classList.contains('down'));
  await T.removeAccount('w2');
  // the mode button's family (one row of controls): the shared class, its dot and the label span with the ellipsis;
  // on a narrow panel it shrinks (it is the only way to the model menu)
  assert.ok(label.classList.contains('mode-cycle'));
  assert.ok(label.querySelector('.mode-dot') && label.querySelector('.mode-label').textContent === label.textContent);
  assert.match(ruleBody('.mode-label'), /text-overflow: ellipsis/);
  assert.match(ruleBody('.chat-model.down .mode-dot'), /background: var\(--danger\)/);
  assert.match(ruleBody('.chat-model.ok .mode-dot'), /background: var\(--ok-fg\)/); // green once verified
  assert.match(ruleBody('.health-dot.ok'), /background: var\(--ok-fg\)/);
  assert.match(css, /@media \(max-width: 340px\) \{\s*\.chat-model \{ max-width: 90px; \}/);
});
