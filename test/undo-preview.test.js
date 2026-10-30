'use strict';
// Undo all previews first: a dry run on one read of the document, a card listing what can be undone and what is
// blocked (relocated edits, replace_all counts, edits whose context a newer edit changed), Cancel, and the apply
// loop that checks every edit again.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, waitFor, load, installDocTab, installIdentity } = require('./lib/sandbox');
const { ORIGINAL, docsBench } = require('./lib/fake-docs');

let fake; let as; // the fake Docs server and the turn snapshot; fresh() replaces both
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, ident, fresh, exec, pushTool;
const sent = []; // messages to the Docs tab

before(async () => {
  env = await load({ hash: '#tabId=7' }); // embedded in a Docs tab: the attention dot goes there
  T = env.T;
  state = env.state;
  ident = installIdentity(env);
  ({ fresh, exec, pushTool } = docsBench(env, ident, ref));
  installDocTab(env);
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic'; state.googleConnected = true;
  env.chrome.tabs.sendMessage = async (id, msg) => { sent.push(msg); return msg.type === 'PING' ? { ok: true, title: 'My Doc' } : { ok: true }; };
});

// A fresh document and chat with one answer that made the given edits ([tool, args] in order); saved, as an
// undo starts from the stored history. Returns the ids, oldest first.
async function answer(edits) {
  for (const id of [...T.pendingPreviews.keys()]) T.decidePreview(id, 'reject'); // left by a failed test
  await fresh();
  await T.createChat();
  state.messages = [{ role: 'user', content: 'Edit it' }];
  const ids = [];
  for (const [i, [name, args]] of edits.entries()) {
    state.messages.push({ role: 'assistant', content: '', tool_calls: [{ id: 'e' + i, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
    const r = pushTool({ role: 'tool', tool_call_id: 'e' + i, ...(await exec(name, args, 'e' + i)) });
    assert.ok(r._ok, r.content);
    ids.push('e' + i);
  }
  await T.saveHistory();
  return ids;
}
// The user retypes a body paragraph.
const setPara = (from, to) => {
  const p = fake.tabs[0].blocks.flatMap((b) => b.paras || []).find((x) => x.text === from);
  p.text = to; fake.revision++;
};
const posts = () => fake.log.filter((x) => x.method === 'POST').length;
const cardEntry = async () => {
  await waitFor(() => T.pendingPreviews.size === 1, 'the Undo all card');
  return [...T.pendingPreviews.entries()][0];
};
const lastCard = () => T.el.chat.children.filter((c) => c && c.className && c.className.includes('tool-card')).pop();
const edits = () => state.messages.filter((m) => m._edit);

test('the preview lists relocated, blocked and stopped edits; Cancel applies nothing; confirm applies as before', async () => {
  const ids = await answer([
    ['replace_text', { old_text: 'Intro', new_text: 'Preface' }],
    ['replace_text', { old_text: 'Last line', new_text: 'Final line' }],
    ['replace_text', { old_text: 'gamma', new_text: 'GAMMA' }],
  ]);
  fake.tabs[0].blocks[0].paras[1].text = 'Preface!! 😀 text.'; fake.revision++; // the user edits right at the oldest edit
  fake.typeParagraph(0, 'Typed'); // and above all of them: they move
  const docBefore = fake.text('t.0');
  const reads = fake.log.length;
  sent.length = 0;
  let p = T.undoAllFromButton(ids[2], null);
  let [id, pv] = await cardEntry();
  assert.strictEqual(fake.log.length - reads, 1, 'one read for the dry run');
  assert.strictEqual(posts(), 3); // the three edits; no request by the dry run
  const html = pv.card.innerHTML;
  assert.ok(html.includes('Undo all 3 edits of this answer?'), html);
  assert.ok(html.includes('2 of 3 edits can be undone; Undo all stops at the blocked one'), html);
  assert.ok(html.includes('↩️ Replaced line 4') && html.includes('↩️ Replaced line 10') && html.includes('⛔ Replaced line 2'), html);
  assert.ok(html.indexOf('Replaced line 4') < html.indexOf('Replaced line 10') && html.indexOf('Replaced line 10') < html.indexOf('Replaced line 2'), 'newest first');
  assert.ok(/Blocked: the document changed near that edit after it was made, so it cannot be undone automatically\. Use Undo \(Ctrl\+Z\) in Google Docs instead\./.test(html), html);
  assert.ok(html.includes('data-act="preview-accept"') && html.includes('>Undo 2</button>') && html.includes('>Cancel</button>') && !html.includes('preview-accept-all'), html);
  assert.ok(sent.some((m) => m.type === 'ATTENTION' && m.pending === true), 'the attention dot while the card waits');
  assert.strictEqual(state.undoing, true);
  // Cancel: nothing changes
  T.decidePreview(id, 'reject');
  assert.strictEqual(await p, false);
  assert.strictEqual(fake.text('t.0'), docBefore);
  assert.strictEqual(posts(), 3);
  assert.ok(edits().every((m) => !m._edit.undone));
  assert.ok(!pv.card.isConnected || !T.el.chat.children.includes(pv.card), 'the card is removed');
  assert.ok(sent.some((m) => m.type === 'ATTENTION' && m.pending === false));
  assert.strictEqual(state.undoing, false);
  // Confirm: the two newer edits are undone where they are now, the blocked one stays
  p = T.undoAllFromButton(ids[2], null);
  [id] = await cardEntry();
  T.decidePreview(id, 'accept');
  assert.strictEqual(await p, false);
  deq(fake.text('t.0').split('\n'), ['Typed', ORIGINAL[0], 'Preface!! 😀 text.', ...ORIGINAL.slice(2)]);
  const card = lastCard();
  assert.ok(card.innerHTML.includes('Undid 2 of 3 edits of this answer'), card.innerHTML);
  assert.ok(card.innerHTML.includes('Undone (newest first):\n- Replaced line 4\n- Replaced line 10\nNot undone (still in the document):\n- Replaced line 2'), card.innerHTML);
});

test('an older edit whose context a newer edit of the answer changed is not reported blocked', async () => {
  // the second edit is right after the first one: the first one's anchor holds only once the second is undone
  const ids = await answer([
    ['replace_text', { old_text: 'beta gamma', new_text: 'beta GAMMA' }],
    ['replace_text', { old_text: 'Alpha beta delta', new_text: 'Omega beta delta' }],
  ]);
  const now = await T.fetchDocModel('DOC123', 't.0');
  assert.throws(() => T.undoableAt(now, edits()[0]._edit), /changed near that edit/); // checked on the document as it is
  const p = T.undoAllFromButton(ids[1], null);
  const [id, pv] = await cardEntry();
  assert.ok(pv.card.innerHTML.includes('All 2 edits can be undone, newest first.') && !pv.card.innerHTML.includes('⛔'), pv.card.innerHTML);
  T.decidePreview(id, 'accept');
  assert.strictEqual(await p, true);
  deq(fake.text('t.0').split('\n'), ORIGINAL);
  assert.ok(lastCard().innerHTML.includes('Undid all 2 edits of this answer'));
});

test('replace_all: a changed occurrence count is shown as blocked', async () => {
  const ids = await answer([
    ['replace_all', { old_text: 'Alpha', new_text: 'Omega' }],
    ['replace_text', { old_text: 'Intro', new_text: 'Preface' }],
  ]);
  fake.tabs[0].blocks[2].paras[0].text = 'Details Omega'; fake.revision++; // a third "Omega" typed by the user
  const p = T.undoAllFromButton(ids[1], null);
  const [id, pv] = await cardEntry();
  const html = pv.card.innerHTML;
  assert.ok(html.includes('1 of 2 edits can be undone') && html.includes('>Undo 1</button>'), html);
  assert.ok(/Blocked: &quot;Omega&quot; now occurs 3 times in the document instead of the 2 inserted by that edit/.test(html), html);
  T.decidePreview(id, 'reject');
  assert.strictEqual(await p, false);
  assert.ok(edits().every((m) => !m._edit.undone));
});

test('nothing undoable: the card has only Close', async () => {
  const ids = await answer([
    ['replace_text', { old_text: 'Intro', new_text: 'Preface' }],
    ['replace_text', { old_text: 'Last line', new_text: 'Final line' }],
  ]);
  setPara('Final line', 'Final line!!');
  const p = T.undoAllFromButton(ids[1], null);
  const [id, pv] = await cardEntry();
  const html = pv.card.innerHTML;
  assert.ok(html.includes('The newest edit cannot be undone, so Undo all would undo nothing.'), html);
  assert.ok(!html.includes('preview-accept') && html.includes('>Close</button>'), html);
  assert.ok(html.includes('⏸️ Replaced line 2') && html.includes('Not undone: Undo all stops at the blocked edit above.'), html);
  T.decidePreview(id, 'reject');
  assert.strictEqual(await p, false);
  assert.strictEqual(posts(), 2);
});

test('an edit blocked between the preview and the confirmation is still refused', async () => {
  const ids = await answer([
    ['replace_text', { old_text: 'Intro', new_text: 'Preface' }],
    ['replace_text', { old_text: 'Last line', new_text: 'Final line' }],
  ]);
  const p = T.undoAllFromButton(ids[1], null);
  const [id, pv] = await cardEntry();
  assert.ok(pv.card.innerHTML.includes('All 2 edits can be undone'));
  fake.tabs[0].blocks[0].paras[1].text = 'Preface!! 😀 text.'; fake.revision++; // while the card waits
  T.decidePreview(id, 'accept');
  assert.strictEqual(await p, false);
  assert.ok(fake.text('t.0').endsWith('\nLast line') && fake.text('t.0').includes('Preface!!'));
  const card = lastCard();
  assert.ok(card.className.includes('fail') && card.innerHTML.includes('Undid 1 of 2 edits of this answer'), card.innerHTML);
  assert.ok(/Stopped at &quot;Replaced line 2&quot;: the document changed near that edit/.test(card.innerHTML), card.innerHTML);
});

test('the single Undo button has no preview', async () => {
  const ids = await answer([
    ['replace_text', { old_text: 'Intro', new_text: 'Preface' }],
    ['replace_text', { old_text: 'Last line', new_text: 'Final line' }],
  ]);
  assert.strictEqual(await T.undoFromButton(ids[1], null), true);
  assert.strictEqual(T.pendingPreviews.size, 0);
  assert.ok(fake.text('t.0').endsWith('\nLast line') && fake.text('t.0').includes('Preface'));
});

test('registered kinds are not pre-checked, nor is anything older', async () => {
  await fresh();
  const doc = { docId: 'DOC123', tabId: 't.0' };
  const items = await T.previewUndoAll([
    { _edit: { ...doc, kind: 'table', title: 'Table inserted' } },
    { _edit: { ...doc, kind: 'replace', title: 'Replaced line 2', index: 1, text: 'x', restore: '', anchor: { before: 'nowhere', after: 'nothing' } } },
  ]);
  deq(items.map((x) => x.status), ['unchecked', 'unchecked']);
  const card = T.undoAllCard(items);
  assert.ok(/2 edits \(a table, footnote or citation, or an edit older than one\) could not be checked in advance/.test(card.why), card.why);
  assert.strictEqual(card.confirm, 'Undo all');
  deq(card.items.map((x) => x.note), ['Not checked in advance; checked when it is undone.', 'Not checked in advance; checked when it is undone.']);
});

test('the Undo all result names what was not restored: embedded objects and re-created lists', async () => {
  const ids = await answer([
    ['delete_lines', { start: 9, end: 9 }], // "Image <object> done"
    ['replace_text', { old_text: 'Intro', new_text: 'Preface' }],
  ]);
  state.messages.find((m) => m._edit && m._edit.id === ids[1])._edit.lists = true; // as a format_lines list write records it
  await T.saveHistory();
  const p = T.undoAllFromButton(ids[1], null);
  const [id] = await cardEntry();
  T.decidePreview(id, 'accept');
  assert.strictEqual(await p, true);
  const html = lastCard().innerHTML;
  assert.ok(html.includes('Embedded objects (images, chips, page breaks) in the removed text could not be restored. Copy them back from File &gt; Version history in Google Docs.'), html);
  assert.ok(html.includes('Note: the list was re-created; numbering, custom bullets or ticks may differ.'), html);
});

test('Undo all covers the edits made before an automatic continuation (_auto) of the same answer', async () => {
  const ids = await answer([
    ['replace_text', { old_text: 'Intro', new_text: 'Preface' }],
    ['replace_text', { old_text: 'gamma', new_text: 'GAMMA' }],
  ]);
  // the panel's continuation request after a length cut sits between the two edits
  const at = state.messages.findIndex((m) => m.role === 'tool' && m.tool_call_id === ids[0]) + 1;
  state.messages.splice(at, 0, { role: 'user', content: T.AUTO_CONTINUE_TEXT, _auto: true });
  await T.saveHistory();
  deq(T.answerEdits(ids[1]).map((m) => m._edit.id), [ids[1], ids[0]]);
  const p = T.undoAllFromButton(ids[1], null);
  const [id] = await cardEntry();
  T.decidePreview(id, 'accept');
  assert.strictEqual(await p, true);
  deq(fake.text('t.0').split('\n'), ORIGINAL);
});

test('while the Undo all card waits, switching, creating and deleting chats are refused; the card still works', async () => {
  const ids = await answer([
    ['replace_text', { old_text: 'Intro', new_text: 'Preface' }],
    ['replace_text', { old_text: 'gamma', new_text: 'GAMMA' }],
  ]);
  const chatA = state.chatId;
  state.messages.push({ role: 'assistant', content: 'Done.' });
  await T.saveHistory();
  // another chat to switch to
  await T.createChat();
  const chatB = state.chatId;
  await T.switchChat(chatA);
  assert.strictEqual(state.chatId, chatA);
  const chatsBefore = state.chats.map((c) => c.id);
  const p = T.undoAllFromButton(ids[1], null);
  const [id, pv] = await cardEntry();
  const refused = () => T.el.chat.children.filter((c) => c && (c.innerHTML || '').includes('Confirm or cancel Undo all first.')).length;
  await T.switchChat(chatB);
  assert.strictEqual(state.chatId, chatA, 'not switched');
  assert.strictEqual(refused(), 1);
  await T.createChat();
  assert.strictEqual(state.chatId, chatA, 'no new chat');
  deq(state.chats.map((c) => c.id), chatsBefore);
  await T.deleteChat(chatB);
  deq(state.chats.map((c) => c.id), chatsBefore, 'nothing deleted');
  assert.strictEqual(refused(), 3);
  assert.strictEqual(await T.startTurn(false), 'idle'); // Enter: the status says the same
  assert.strictEqual(T.el.docStatus.textContent, 'Confirm or cancel Undo all first.');
  assert.ok(T.pendingPreviews.has(id) && T.el.chat.children.includes(pv.card), 'the card is still there');
  T.decidePreview(id, 'accept');
  assert.strictEqual(await p, true);
  deq(fake.text('t.0').split('\n'), ORIGINAL);
  assert.ok(state.messages.filter((m) => m._edit).every((m) => m._edit.undone));
  const stored = await T.readChatHistory(state.docId, chatA);
  assert.ok(stored.filter((m) => m._edit).every((m) => m._edit.undone), 'saved into chat A');
  // afterwards the chat can be left again
  await T.switchChat(chatB);
  assert.strictEqual(state.chatId, chatB);
});
