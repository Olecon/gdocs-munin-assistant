'use strict';
// Scripted turns on a real DOM (jsdom) with the fake Docs API: a write has no pending card. While it runs, the chat
// holds no card for it (no "Editing the document…" element); its progress is the bubble's status line. After it, a
// success is its action-log row, a failure its failed row (no card; remember is a write here too);
// no `.tool-card.pending` is left in any path (insert_after_line, edit_document, a failed write, a registered writing
// tool, a call that is never run). Decision cards (the edit gate,
// ask_user, open_document, the access card) turn into their answered state in place (no second, green card) and are
// drawn the same from the stored chat.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { load, click } = require('../lib/dom-sandbox');
const { installDocTab, installIdentity, waitFor } = require('../lib/sandbox');
const { docSpec, docsBench } = require('../lib/fake-docs');
const { sseResponse, ev, tu, msgStart, stopTool, textRound } = require('../lib/streams');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, el, chrome, bench;
const $$ = (sel) => [...el.chat.querySelectorAll(sel)];
// A decided card is one row (gate.js answerCard): "<tool> · <answer> · <preview>"; its fold holds what it asked.
const answerOf = (c) => c.querySelector('.log-status').textContent;
const rowText = (c) => c.querySelector('summary').textContent;
const askedOf = (c) => c.querySelector('.log-body .log-asked').textContent;
const decisions = () => $$('.tool-card, .answered-row'); // the boxed cards and the answered rows

before(async () => {
  env = await load();
  ({ T, state, el, chrome } = env);
  bench = docsBench(env, installIdentity(env), ref);
  installDocTab(env);
  chrome.tabs.sendMessage = async (id, msg) => (msg.type === 'GET_SELECTION' ? { ok: true, text: '' } : { ok: true, title: 'My Doc' });
  await T.refreshContext({ force: true });
});
after(() => env.close());

// A turn on the fake document: the model's rounds (Anthropic SSE), in order. While the Docs API receives a write (a
// POST), the chat is looked at: during[] gets { cards (tool cards in the chat), pending, place (the live bubble's status
// line) }. onModel(n): called before the model's n-th response (0-based), to look at the chat between rounds.
// Returns { during, turn } (turn: the sendMessage promise).
async function startTurn(rounds, text, spec, onModel, mode = 'auto') {
  await T.createChat(); // a new chat for every turn (the previous test's chat has messages)
  await bench.fresh(spec || docSpec());
  state.googleConnected = true; state.applyMode = mode; state.settings.provider = 'anthropic';
  Object.assign(state.settings.providers.anthropic, { apiKey: 'sk-ant-X', model: 'claude-opus-5-5', baseUrl: 'https://api.anthropic.com/v1' });
  T.renderHistory();
  const during = [];
  let n = 0;
  const docs = fake.fetch;
  fake.fetch = async (url, init) => {
    if (init && init.method === 'POST') {
      const b = [...el.chat.querySelectorAll('.msg.assistant')].pop();
      const place = b && b.querySelector('.thinking-label');
      // only while a call of the turn runs (its row is pending); the document's own POSTs before and after do not count
      if (b && b.querySelector('.activity-row.pending')) {
        during.push({ cards: $$('.tool-card').length, pending: $$('.tool-card.pending').length, place: place && !b.querySelector('.thinking').classList.contains('hidden') ? place.textContent : '' });
      }
    }
    return docs(url, init);
  };
  env.ctx.fetch = bench.routeDocs(async () => { if (onModel) onModel(n); return sseResponse(rounds[Math.min(n++, rounds.length - 1)]); });
  el.input.value = text;
  return { during, turn: T.sendMessage() };
}
const round = (id, name, args) => msgStart + tu(0, id, name, args) + stopTool;

test('insert_after_line: no card while it writes, the status line shows where; after it only the row', async () => {
  const { during, turn } = await startTurn([round('t1', 'insert_after_line', { line: 4, text: 'New line.' }), textRound('Inserted.')], 'Add a line');
  await turn;
  assert.ok(during.length >= 1);
  for (const d of during) {
    assert.deepStrictEqual([d.cards, d.pending], [0, 0], 'no card element while the write runs');
    assert.match(d.place, /^Writing in Methods, after line 4$|^Verifying the edit/, d.place);
  }
  assert.ok(fake.text('t.0').includes('New line.'));
  assert.deepStrictEqual([$$('.tool-card').length, $$('.tool-card.pending').length], [0, 0]);
  assert.strictEqual($$('.activity-row.write-row').length, 1);
});

test('edit_document: no card while it writes ("Writing 2 edits"), none after a success', async () => {
  const ops = [{ op: 'replace', old_text: 'beta gamma', new_text: 'beta GAMMA' }, { op: 'insert', line: 1, text: 'Added.' }];
  const { during, turn } = await startTurn([round('t2', 'edit_document', { operations: ops }), textRound('Done.')], 'Two edits');
  await turn;
  assert.ok(during.length >= 1, 'written');
  for (const d of during) {
    assert.deepStrictEqual([d.cards, d.pending], [0, 0]);
    assert.match(d.place, /^Writing 2 edits$|^Verifying the edit/, d.place);
  }
  assert.ok(fake.text('t.0').includes('Alpha beta GAMMA.'), fake.text('t.0'));
  assert.deepStrictEqual([$$('.tool-card').length, $$('.tool-card.pending').length], [0, 0]);
});

// A failed replace_text's row (in its stage, marked failed, the model's error text in its fold, its round's dot red) or null.
const failedRow = () => {
  const rows = $$('.activity-row.log-row.fail').filter((r) => r.querySelector('.activity-name').textContent === 'replace_text');
  if (rows.length !== 1) return null;
  const r = rows[0];
  return { inStage: !!r.closest('.msg.assistant .stage-rows'), status: r.querySelector('summary').textContent.endsWith(' · failed'),
    result: /^Error: old_text was not found in the document/.test(r.querySelectorAll('.log-body pre')[1].textContent), redDot: !!r.closest('.stage.tl-fail') };
};

test('a failed write: no card, its failed row with the result in its fold and a red dot, live and after a reload', async () => {
  let live = null;
  const rounds = [round('r1', 'read_document', { scope: { start: 1, end: 2 }, include: ['text'], doc: null }),
    round('t3', 'replace_text', { old_text: 'not in this document', new_text: 'x' }), textRound('It is not there.')];
  const { turn } = await startTurn(rounds, 'Replace', null, (n) => {
    if (n !== 2) return;
    live = { cards: $$('.tool-card').length, row: failedRow() };
  });
  await turn;
  const want = { inStage: true, status: true, result: true, redDot: true };
  assert.deepStrictEqual(live, { cards: 0, row: want }, 'live, before the next round');
  const check = () => {
    assert.strictEqual($$('.tool-card').length, 0);
    assert.deepStrictEqual(failedRow(), want);
  };
  check();
  state.messages = JSON.parse(JSON.stringify(state.messages));
  T.renderHistory();
  check();
});

// remember is a write like the others: no card while it runs or after a success, its row "remember · Done · DOC.md:
// added «rule»" in the stage of its round; its fold names the file and scope and the action, and shows the rule.
const rememberRow = () => {
  const rows = $$('.activity-row.write-row').filter((r) => r.querySelector('.activity-name').textContent === 'remember');
  if (rows.length !== 1) return null;
  const r = rows[0];
  return { inStage: !!r.closest('.msg.assistant .stage-rows'), status: r.querySelector('.log-status').textContent,
    preview: r.querySelector('.log-preview').textContent, what: r.querySelector('.log-what').textContent,
    detail: r.querySelector('.log-detail').textContent, text: r.querySelector('.log-text').textContent };
};
test('remember: no card, its row with the rule as the preview, live and after a reload', async () => {
  let live = null;
  const rounds = [round('m1', 'remember', { action: 'add', scope: 'document', text: 'Use British spelling.', old_text: null }), textRound('Noted.')];
  const { turn } = await startTurn(rounds, 'Remember: British spelling', null, (n) => {
    if (n === 1) live = { cards: $$('.tool-card').length, row: rememberRow() };
  });
  await turn;
  const want = { inStage: true, status: 'Done', preview: ' · DOC.md: added «Use British spelling.»', what: 'Added to DOC.md: «Use British spelling.»',
    detail: 'DOC.md (scope document), action add', text: 'Use British spelling.' };
  assert.deepStrictEqual(live, { cards: 0, row: want });
  const check = () => {
    assert.strictEqual($$('.tool-card').length, 0);
    assert.strictEqual($$('button[data-act="revert-remember"]').length, 0);
    assert.deepStrictEqual(rememberRow(), want);
  };
  check();
  state.messages = JSON.parse(JSON.stringify(state.messages));
  T.renderHistory();
  check();
});

test('remember remove: the removed rule is the preview; a failed remember is its failed row, no card', async () => {
  await T.writeDocInstructions(state.docId, 'Use British spelling.\nShort sentences.');
  const rounds = [msgStart + tu(0, 'm2', 'remember', { action: 'remove', scope: 'document', text: 'Short sentences.', old_text: null }) +
    tu(1, 'm3', 'remember', { action: 'remove', scope: 'main', text: 'Not there.', old_text: null }) + stopTool, textRound('Removed.')];
  const { turn } = await startTurn(rounds, 'Forget short sentences');
  await turn;
  const check = () => {
    const row = rememberRow();
    assert.ok(row, 'one successful remember row');
    assert.deepStrictEqual([row.preview, row.detail, row.what], [' · DOC.md: removed «Short sentences.»', 'DOC.md (scope document), action remove',
      'Removed from DOC.md: «Short sentences.»']);
    assert.strictEqual($$('.tool-card').length, 0);
    const fail = $$('.activity-row.log-row.fail');
    assert.strictEqual(fail.length, 1);
    assert.match(fail[0].querySelectorAll('.log-body pre')[1].textContent, /^Error: MAIN\.md is empty\./);
  };
  check();
  state.messages = JSON.parse(JSON.stringify(state.messages));
  T.renderHistory();
  check();
});

test('a history stored with the old Revert data (_remember.reverted, the revert note) renders the plain row, no button', () => {
  const rem = { id: 'v1', type: 'function', function: { name: 'remember', arguments: '{"action":"replace","scope":"main","text":"Use US spelling.","old":"Use British spelling."}' } };
  state.messages = [
    { role: 'user', content: 'x' },
    { role: 'assistant', content: null, tool_calls: [rem] },
    { role: 'tool', tool_call_id: 'v1', content: 'MAIN.md now:\nUse US spelling.\n[Later the user reverted this change with the Revert button.]', _ok: true,
      _message: 'Changed in MAIN.md: «Use British spelling.» → «Use US spelling.»', _icon: '📌', _cardText: '',
      _remember: { scope: 'main', action: 'replace', text: 'Use US spelling.', old: 'Use British spelling.', index: 0, reverted: true } },
    { role: 'assistant', content: 'Changed.' },
  ];
  T.renderHistory();
  assert.strictEqual($$('.tool-card').length, 0);
  assert.strictEqual($$('button[data-act="revert-remember"]').length, 0);
  const r = $$('.activity-row.write-row')[0];
  assert.strictEqual(r.querySelector('.log-preview').textContent, ' · MAIN.md: replaced «Use British spelling.» → «Use US spelling.»');
  assert.strictEqual(r.querySelector('.log-detail').textContent, 'MAIN.md (scope main), action replace');
  assert.ok(r.querySelector('.word-diff'), 'a replaced rule: what changed');
});

test('a remember row has the markup of the other write rows, running and done: the same classes, fold frame and parts', () => {
  const ins = { id: 'w1', type: 'function', function: { name: 'insert_after_line', arguments: '{"line":2,"text":"New line."}' } };
  const rem = { id: 'w2', type: 'function', function: { name: 'remember', arguments: '{"action":"add","scope":"main","text":"Short sentences.","old":null}' } };
  const shape = (r) => ({ tag: r.tagName, cls: [...r.classList].sort(), kids: [...r.children].map((c) => c.tagName + '.' + c.className),
    sum: [...r.querySelectorAll('summary > *')].map((c) => c.className), body: [...r.querySelectorAll('.log-body > *')].map((c) => c.className) });
  const rowOf = (name) => $$('.stage-rows > .activity-row').find((r) => r.querySelector('.activity-name').textContent === name);
  // running: both pending rows alike
  state.messages = [{ role: 'user', content: 'x' }, { role: 'assistant', content: null, tool_calls: [ins] }, { role: 'assistant', content: null, tool_calls: [rem] }];
  T.renderHistory();
  assert.deepStrictEqual(shape(rowOf('remember')), shape(rowOf('insert_after_line')));
  assert.strictEqual(rowOf('remember').textContent, 'remember: MAIN.md: add «Short sentences.» …');
  // done: both write rows alike, the remember row with the file and the change as its preview and the rule in its fold
  state.messages = [
    { role: 'user', content: 'x' },
    { role: 'assistant', content: null, tool_calls: [ins] },
    { role: 'tool', tool_call_id: 'w1', content: 'Inserted.', _ok: true, _message: 'Inserted after line 2', _cardText: 'New line.' },
    { role: 'assistant', content: null, tool_calls: [rem] },
    { role: 'tool', tool_call_id: 'w2', content: 'MAIN.md now:\nShort sentences.', _ok: true, _message: 'Added to MAIN.md: «Short sentences.»', _cardText: '',
      _remember: { scope: 'main', action: 'add', text: 'Short sentences.', index: 0 } },
    { role: 'assistant', content: 'Done.' },
  ];
  T.renderHistory();
  const r = rowOf('remember');
  const w = shape(rowOf('insert_after_line'));
  assert.deepStrictEqual(shape(r), { ...w, body: ['log-what', 'log-detail', ...w.body.slice(1)] }, 'its fold adds the file, scope and action');
  assert.deepStrictEqual(w.body.slice(0, 1), ['log-what']);
  assert.strictEqual(r.querySelector('summary').textContent, 'remember · Done · MAIN.md: added «Short sentences.»');
  assert.deepStrictEqual([r.querySelector('.log-what').textContent, r.querySelector('.log-detail').textContent, r.querySelector('.log-label').textContent,
    r.querySelector('.log-text').textContent], ['Added to MAIN.md: «Short sentences.»', 'MAIN.md (scope main), action add', 'Rule', 'Short sentences.']);
  assert.strictEqual(r.querySelector('.row-acts'), null, 'no Revert (and no Undo: this stored result has no journal entry)');
});

test('a stored edit allowed at the gate that then failed: the failed row, the answered card, no failure card', () => {
  const del = { id: 'd1', type: 'function', function: { name: 'delete_lines', arguments: '{"start":2,"end":30}' } };
  state.messages = [
    { role: 'user', content: 'x' },
    { role: 'assistant', content: null, tool_calls: [del] },
    { role: 'tool', tool_call_id: 'd1', content: 'Error: the document changed.', _ok: false, _decision: 'accepted', _message: 'Not applied: the document changed',
      _answered: [{ kind: 'edit', tool: 'delete_lines', title: 'Allow this edit?', text: 'Large edit: it deletes 29 lines.', decision: 'accept' }] },
    { role: 'assistant', content: 'It changed.' },
  ];
  T.renderHistory();
  const rows = [...el.chat.querySelector('.msg.assistant .stage-rows').children];
  assert.deepStrictEqual(rows.map((c) => (c.classList.contains('activity-row') ? 'row' : c.classList.contains('answered-row') ? 'answered' : c.className)),
    ['row', 'answered']);
  assert.ok(rows[0].classList.contains('fail'));
  assert.strictEqual($$('.tool-card').length, 0);
});

test('a registered writing tool (table): no card while it writes, its pending text on the status line; the row after', async () => {
  const args = { action: 'insert', line: 4, table: null, row: null, column: null, rows: 2, columns: 2, cells: null, width: null };
  const { during, turn } = await startTurn([round('t4', 'table', args), textRound('Table added.')], 'Add a table');
  await turn;
  assert.ok(during.length >= 1, 'written');
  for (const d of during) {
    assert.deepStrictEqual([d.cards, d.pending], [0, 0]);
    assert.match(d.place, /^Changing a table…$|^Verifying the edit/, d.place);
  }
  assert.deepStrictEqual([$$('.tool-card').length, $$('.tool-card.pending').length], [0, 0]);
  assert.strictEqual($$('.activity-row.write-row').length, 1);
});

test('a remember call that is never run (cut by the length limit) leaves no card', async () => {
  const cut = msgStart + tu(0, 't5', 'remember', { action: 'add', scope: 'document', text: 'Use British spelling.', old_text: null }) +
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 9 } }) + ev('message_stop', { type: 'message_stop' });
  const { turn } = await startTurn([cut, textRound('Continued.')], 'Remember British spelling');
  await turn;
  assert.strictEqual($$('.tool-card').length, 0);
});

test('the edit gate (Manual): the card shows the whole change and turns into "Allowed" in place, no green card; the stored chat draws it again', async () => {
  const LONG = Array.from({ length: 25 }, (_, i) => ({ p: `Line ${i + 2} text.` }));
  const spec = docSpec({ items: [{ p: 'Big', style: 'TITLE' }, ...LONG] });
  const rounds = [round('r1', 'read_document', { scope: { start: 2, end: 22 }, include: ['text'], doc: null }),
    round('d1', 'delete_lines', { start: 2, end: 22 }), textRound('Deleted.')];
  const { turn } = await startTurn(rounds, 'Delete lines 2-22', spec, undefined, 'manual');
  await waitFor(() => $$('.tool-card.preview:not(.decided)').length === 1, 'the gate card');
  // the card: the sentence, then the removed lines whole in an edit block's look (label bar, body text), the buttons below
  const live = $$('.tool-card.preview:not(.decided)')[0];
  assert.strictEqual(live.querySelector('.pv-edit .pv-note').textContent, 'Deletes lines 2–22.');
  assert.strictEqual(live.querySelector('.pv-edit .code-wrap.edit-block .code-bar .code-lang').textContent, 'Removed: lines 2–22');
  assert.strictEqual(live.querySelector('.pv-edit .edit-block pre').textContent, Array.from({ length: 21 }, (_, i) => `Line ${i + 2} text.`).join('\n'));
  assert.strictEqual(live.querySelector('.pv-body'), null);
  assert.ok(live.querySelector('.pv-edit').nextElementSibling.matches('.pv-actions'));
  click($$('.tool-card.preview:not(.decided) button[data-act="preview-accept"]')[0]);
  await turn;
  const check = () => {
    const cards = decisions();
    assert.strictEqual(cards.length, 1, cards.map((c) => c.outerHTML).join('\n'));
    assert.ok(cards[0].classList.contains('answered-row') && !cards[0].classList.contains('tool-card') && !cards[0].classList.contains('ok'));
    assert.strictEqual(answerOf(cards[0]), 'Allowed');
    assert.match(rowText(cards[0]), /^delete_lines · Allowed · Deletes lines 2–22\./);
    assert.match(askedOf(cards[0]), /^Deletes lines 2–22\./);
    assert.strictEqual(cards[0].querySelectorAll('button').length, 0);
    assert.ok(cards[0].parentElement.matches('.msg.assistant .stage-rows'), 'in the bubble, at its call');
    assert.strictEqual(cards[0].previousElementSibling.querySelector('.activity-name').textContent, 'delete_lines');
  };
  check();
  state.messages = JSON.parse(JSON.stringify(state.messages)); // as read back from storage
  T.renderHistory();
  check();
});

test('the edit gate: Allow all in this turn and Deny read as such', async () => {
  const spec = docSpec({ items: [{ p: 'Big', style: 'TITLE' }, ...Array.from({ length: 25 }, (_, i) => ({ p: `Line ${i + 2} text.` }))] });
  for (const [act, want] of [['preview-accept-all', 'Allowed all in this turn'], ['preview-reject', 'Denied']]) {
    const rounds = [round('r1', 'read_document', { scope: { start: 2, end: 22 }, include: ['text'], doc: null }),
      round('d1', 'delete_lines', { start: 2, end: 22 }), textRound('OK.')];
    const { turn } = await startTurn(rounds, 'Delete lines 2-22', spec, undefined, 'manual');
    await waitFor(() => $$('.tool-card.preview:not(.decided)').length === 1, 'the gate card');
    click($$(`.tool-card.preview:not(.decided) button[data-act="${act}"]`)[0]);
    await turn;
    const cards = decisions();
    assert.strictEqual(cards.length, 1, act); // a denied edit: no red card under the answered one
    assert.strictEqual(answerOf(cards[0]), want);
  }
});

// ask_user in a turn: the question card turns into its answered state.
async function askTurn(options, decide, questions = [{ question: 'Which section?', options }]) {
  const rounds = [round('q1', 'ask_user', { questions }), textRound('OK.')];
  const { turn } = await startTurn(rounds, 'Shorten something');
  await waitFor(() => $$('.tool-card.ask:not(.decided)').length === 1, 'the question card');
  const card = $$('.tool-card.ask')[0];
  decide(card);
  await turn;
  return card;
}

test('ask_user: a chosen option, Stop and a dash read well; no "You chose" card; a reload keeps it', async () => {
  const cases = [
    [['Introduction', 'Methods'], (c) => click(c.querySelectorAll('button[data-ask]')[1]), 'Chosen: Methods'],
    [['—', 'Methods'], (c) => click(c.querySelectorAll('button[data-ask]')[0]), 'Answered in the chat'],
    [['Introduction', 'Methods'], () => state.abort.abort(), 'Stopped'],
  ];
  for (const [options, decide, want] of cases) {
    await askTurn(options, decide);
    const check = () => {
      const cards = decisions();
      assert.strictEqual(cards.length, 1, want);
      assert.ok(cards[0].classList.contains('answered-row') && cards[0].classList.contains('ask') && !cards[0].classList.contains('ok'));
      assert.strictEqual(rowText(cards[0]), `ask_user · ${want} · Which section?`);
      assert.strictEqual(askedOf(cards[0]), 'Which section?');
      assert.strictEqual(answerOf(cards[0]), want);
      assert.ok(!el.chat.textContent.includes('You chose') && !/Chosen: [—-]?$/.test(answerOf(cards[0])));
      assert.ok(cards[0].parentElement.matches('.msg.assistant .stage-rows'), 'in the bubble, at its call');
    };
    check();
    state.messages = JSON.parse(JSON.stringify(state.messages));
    T.renderHistory();
    check();
  }
});

test('ask_user with three questions in a turn: the answers by click, Other and Send; the row and its fold survive a reload', async () => {
  const questions = [{ question: 'Which section?', options: ['Introduction', 'Methods'] }, { question: 'How short?', options: ['Half', 'A third'] },
    { question: 'Anything to keep?', options: [] }];
  await askTurn(null, (c) => {
    click(c.querySelector('button[data-ask="1"]'));
    click(c.querySelector('button[data-ask="0"]'));
    const input = c.querySelector('input.ask-other');
    input.value = 'The figures';
    input.dispatchEvent(new input.ownerDocument.defaultView.Event('input', { bubbles: true }));
    click(c.querySelector('button[data-ask="send"]'));
  }, questions);
  const tool = state.messages.find((m) => m.role === 'tool');
  assert.strictEqual(tool.content, 'The user answered:\n1. Which section? \u2014 Methods\n2. How short? \u2014 Half\n3. Anything to keep? \u2014 The figures');
  const check = () => {
    const cards = decisions();
    assert.strictEqual(cards.length, 1);
    assert.strictEqual(rowText(cards[0]), 'ask_user · Answered 3 questions · Which section?');
    assert.deepStrictEqual([...cards[0].querySelectorAll('.log-asked')].map((x) => x.textContent),
      ['1. Which section? \u2014 Methods', '2. How short? \u2014 Half', '3. Anything to keep? \u2014 The figures']);
    assert.ok(cards[0].parentElement.matches('.msg.assistant .stage-rows'), 'in the bubble, at its call');
  };
  check();
  state.messages = JSON.parse(JSON.stringify(state.messages));
  T.renderHistory();
  check();
});

test('a chat stored before the answered cards: "You chose: —" is drawn as "Answered in the chat"; a denied edit as "Denied"', () => {
  const ask = { id: 'a1', type: 'function', function: { name: 'ask_user', arguments: '{"question":"Q?","options":["—","B"]}' } };
  const del = { id: 'd1', type: 'function', function: { name: 'delete_lines', arguments: '{"start":2,"end":30}' } };
  state.messages = [
    { role: 'user', content: 'x' },
    { role: 'assistant', content: null, tool_calls: [ask, del] },
    { role: 'tool', tool_call_id: 'a1', content: 'The user chose: —.', _ok: true, _decision: 'answered', _message: 'You chose: —', _detail: 'Q?', _cardText: '' },
    { role: 'tool', tool_call_id: 'd1', content: 'The user did not allow this edit.', _ok: false, _decision: 'rejected', _message: 'Edit not allowed' },
    { role: 'assistant', content: 'OK.' },
  ];
  T.renderHistory();
  const cards = decisions();
  assert.deepStrictEqual(cards.map((c) => [c.classList.contains('answered-row'), answerOf(c)]), [[true, 'Answered in the chat'], [true, 'Denied']]);
  assert.strictEqual($$('.tool-card.ok, .tool-card.fail').length, 0);
});

// A decision card waits in the turn's one bubble, in its cards slot (never in a fold, never inside the activity); once
// answered, its row goes into the stage of its round after the call's row, folded with the stage, the later rounds below
// it, and the same place after a reload.
test('ask_user in the second of three tool rounds: the card waits in the bubble\'s cards slot, the answered row in its stage', async () => {
  const shown = (n) => !!n && !n.closest('.hidden');
  const read = (id, start) => round(id, 'read_document', { scope: { start, end: start }, include: ['text'], doc: null });
  const ask = msgStart + tu(0, 'r2', 'read_document', { scope: { start: 2, end: 2 }, include: ['text'], doc: null }) +
    tu(1, 'q1', 'ask_user', { question: 'Which section?', options: ['Introduction', 'Methods'] }) + stopTool;
  const { turn } = await startTurn([read('r1', 1), ask, read('r3', 3), textRound('Done.')], 'Shorten something');
  await waitFor(() => $$('.tool-card.ask:not(.decided)').length === 1, 'the question card');
  const card = $$('.tool-card.ask')[0];
  const bubble = card.closest('.msg.assistant');
  assert.ok(bubble, 'inside the turn\'s bubble');
  assert.strictEqual(el.chat.querySelectorAll(':scope > .tool-card').length, 0, 'no card after the bubble');
  const stages = [...bubble.querySelectorAll('.activity-rows > .stage')];
  assert.strictEqual(stages.length, 2);
  assert.strictEqual(card.parentElement, bubble.querySelector('.msg-cards'), 'in the bubble\'s cards slot');
  assert.strictEqual(card.closest('.activity'), null, 'never inside the activity');
  assert.deepStrictEqual([...stages[1].querySelector('.stage-rows').children].map((c) => c.querySelector('.activity-name').textContent),
    ['read_document', 'ask_user']);
  // round 2's action row (2 calls) stays folded as the user left it; the question is visible all the same
  assert.ok(!stages[1].querySelector('.stage-head').classList.contains('hidden'));
  assert.strictEqual(stages[1].querySelector('.stage-line').getAttribute('aria-expanded'), 'false');
  assert.ok(shown(card), 'the question is visible');
  assert.strictEqual(bubble.querySelector('.thinking-label').textContent, 'Asking…');
  assert.strictEqual(bubble.querySelector('.thinking canvas.orb').dataset.orb, 'wave');
  click(card.querySelectorAll('button[data-ask]')[1]);
  await turn;
  const check = () => {
    const [c] = decisions();
    assert.strictEqual(decisions().length, 1);
    assert.strictEqual(answerOf(c), 'Chosen: Methods');
    const b = c.closest('.msg.assistant');
    const st = [...b.querySelectorAll('.activity-rows > .stage')].filter((x) => !x.classList.contains('hidden'));
    assert.strictEqual(st.length, 3);
    assert.strictEqual(c.parentElement, st[1].querySelector('.stage-rows'));
    assert.strictEqual(c.previousElementSibling.querySelector('.activity-name').textContent, 'ask_user');
    // the round after the answer is below the card, not above it
    assert.ok(c.compareDocumentPosition(st[2]) & 4, 'round 3 follows the card');
    assert.ok(!shown(c), 'answered: folded with its round under its collapsed action row');
    assert.strictEqual(st[1].querySelector('.stage-line').getAttribute('aria-expanded'), 'false');
    assert.strictEqual(el.chat.querySelectorAll(':scope > .tool-card').length, 0);
  };
  check();
  state.messages = JSON.parse(JSON.stringify(state.messages)); // as read back from storage
  T.renderHistory();
  check();
});
