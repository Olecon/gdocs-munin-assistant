'use strict';
// Paste fallback safety (panel side): replace_selection passes the selection the model saw as
// "expected"; a 'selection-changed' answer of the content script copies the text to the clipboard, shows
// a notice and tells the model; without an expected selection (insert at the cursor) nothing changes.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { load, installDocTab } = require('./lib/sandbox');

let env, T, state, chrome, sandbox, sent, reply, clip;

before(async () => {
  env = await load();
  T = env.T;
  state = env.state;
  chrome = env.chrome;
  sandbox = env.ctx;
  installDocTab(env);
  await T.refreshContext({ force: true });
  state.googleConnected = false; // the paste path (no Docs API)
  sent = [];
  reply = { ok: true };
  chrome.tabs.sendMessage = async (id, msg) => {
    if (msg.type === 'REPLACE_SELECTION') { sent.push(msg); return typeof reply === 'function' ? reply(msg) : reply; }
    return { ok: true, text: '' };
  };
  clip = [];
  sandbox.navigator.clipboard.writeText = async (t) => { clip.push(t); };
});

const pasteOk = () => JSON.stringify({ ok: true, note: T.PASTE_DONE_NOTE }); // the model's result of any paste
const notices = () => T.el.chat.children.filter((c) => c.className.includes('notice')).map((c) => c.innerHTML);
function snapWith(selection) {
  state.settings.provider = 'anthropic';
  state.settings.providers.anthropic.apiKey = 'k';
  const snap = T.takeSnapshot(); T.snapshotDocument(snap);
  snap.selection = selection;
  return snap;
}
const call = (snap, text) => T.executeTool({ id: 'rs' + Math.random(), function: { name: 'replace_selection', arguments: JSON.stringify({ text }) } }, 'edit', snap);

test('replace_selection sends the selection the model saw as "expected"; pasted when it matches', async () => {
  sent.length = 0; clip.length = 0; reply = { ok: true };
  const r = await call(snapWith('quick brown'), 'fast brown');
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].text, 'fast brown'); assert.strictEqual(sent[0].expected, 'quick brown');
  assert.ok(r._ok); assert.strictEqual(r.content, pasteOk());
  assert.strictEqual(clip.length, 0);
});

test('selection-changed: no paste, the text goes to the clipboard, a notice, and the model is told', async () => {
  sent.length = 0; clip.length = 0; T.el.chat.children.length = 0;
  reply = { ok: false, reason: 'selection-changed', error: 'the selection changed while the answer was being generated' };
  const r = await call(snapWith('quick brown'), 'fast brown');
  assert.strictEqual(sent.length, 1);
  assert.deepStrictEqual(clip, ['fast brown']);
  assert.strictEqual(r._ok, false);
  assert.strictEqual(r._message, 'The selection changed while the answer was being generated; the text was copied to the clipboard instead.');
  assert.strictEqual(r.content, 'Error: the user changed the selection in the document while you were answering, so the text was not pasted. ' +
    'It was copied to the clipboard; the user can paste it where they want with Ctrl+V. Do not call the tool again.');
  assert.deepStrictEqual(notices(), ['The selection changed while the answer was being generated; the text was copied to the clipboard instead.']);
  // the clipboard fails too: the model is asked to show the text in the chat
  T.el.chat.children.length = 0;
  sandbox.navigator.clipboard.writeText = async () => { throw new Error('denied'); };
  try {
    const r2 = await call(snapWith('quick brown'), 'fast brown');
    assert.ok(r2.content.includes('so the text was not pasted. Show the text in the chat so the user can paste it manually.'));
    assert.ok(notices()[0].startsWith('The selection changed while the answer was being generated, so the text was not pasted; copying it to the clipboard also failed.'));
  } finally {
    sandbox.navigator.clipboard.writeText = async (t) => { clip.push(t); };
  }
});

test('no expected selection (insert at the cursor) and the Apply buttons keep the old behavior', async () => {
  sent.length = 0; clip.length = 0; T.el.chat.children.length = 0; reply = { ok: true };
  const r = await call(snapWith(''), 'inserted');
  assert.ok(r._ok);
  assert.strictEqual(sent.length, 1); assert.ok(!('expected' in sent[0]));
  // the "Apply to selection" path (applyToDocument without expected)
  const a = await T.applyToDocument('from the button');
  assert.ok(a.ok); assert.ok(!('expected' in sent[1]));
  // an ordinary paste failure keeps its old messages
  reply = { ok: false, error: 'paste event not handled' };
  const f = await call(snapWith(''), 'x');
  assert.strictEqual(f.content, 'Error: automatic paste failed. The text was copied to the clipboard and the user will paste it manually with Ctrl+V. Do not call the tool again.');
  assert.ok(f._message.startsWith('Could not paste automatically. The text was copied to the clipboard'));
  assert.deepStrictEqual(notices(), []);
  // replacements stay queued one at a time
  const order = [];
  reply = async (msg) => { order.push('start ' + msg.text); await new Promise((res) => setTimeout(res, 10)); order.push('end ' + msg.text); return { ok: true }; };
  await Promise.all([T.applyToDocument('one', 'sel'), T.applyToDocument('two')]);
  assert.deepStrictEqual(order, ['start one', 'end one', 'start two', 'end two']);
  assert.strictEqual(sent[sent.length - 2].expected, 'sel');
});

test('a normal paste: how it was inserted and the attempts reach the tool card and the action log', async () => {
  sent.length = 0; clip.length = 0; T.el.chat.children.length = 0;
  reply = { ok: true, method: 'paste', detail: 'inserted via paste event (detected by the editor change)', attempts: 2 };
  const tc = { id: 'rs-detail', function: { name: 'replace_selection', arguments: JSON.stringify({ text: 'pasted' }) } };
  const r = await T.executeTool(tc, 'edit', snapWith(''));
  assert.ok(r._ok);
  assert.strictEqual(r._detail, 'inserted via paste event (detected by the editor change) · 2 attempts');
  assert.strictEqual(r._attempts, 2);
  assert.strictEqual(r.content, pasteOk()); // the detail stays on the card, the model gets the assertive note
  assert.strictEqual(T.logEntry(tc, r).result, r.content); // the action log row shows what the model received
  const card = T.toolCardFor(tc, r);
  assert.ok(card.innerHTML.includes('inserted via paste event (detected by the editor change) · 2 attempts'), card.innerHTML);
  // the Apply button's path gets the same detail
  reply = { ok: true, method: 'paste', detail: 'inserted via paste event', attempts: 1 };
  const a = await T.applyToDocument('from the button');
  assert.deepStrictEqual([a.ok, a.detail, a.attempts], [true, 'inserted via paste event', 1]);
});

test('a paste Docs did not confirm (verified false): ok for the model with the assertive note, no clipboard, the card says so', async () => {
  sent.length = 0; clip.length = 0; T.el.chat.children.length = 0;
  const detail = '';
  reply = { ok: true, method: 'paste', verified: false, attempts: 1, detail };
  const tc = { id: 'rs-unverified', function: { name: 'replace_selection', arguments: JSON.stringify({ text: 'pasted' }) } };
  const r = await T.executeTool(tc, 'edit', snapWith(''));
  assert.strictEqual(sent.length, 1); // sent once, never retried
  assert.strictEqual(r._ok, true);
  assert.strictEqual(r._message, 'Pasted');
  assert.deepStrictEqual(JSON.parse(r.content), { ok: true, note: T.PASTE_DONE_NOTE }); // nothing that invites a re-read
  assert.ok(!r._detail, 'no detail line for a normal paste'); // one attempt is the rule, not news
  assert.deepStrictEqual(clip, []); // no clipboard fallback
  assert.deepStrictEqual(notices(), []); // and no notice
  const card = T.toolCardFor(tc, r);
  assert.ok(card.innerHTML.includes('Pasted'), card.innerHTML);
  // the Apply button's path: ok, not verified, the same message, no clipboard
  const a = await T.applyToDocument('from the button');
  assert.deepStrictEqual([a.ok, a.verified, a.message], [true, false, 'Pasted']);
  assert.deepStrictEqual(clip, []);
  // a confirmed paste keeps the old message and has no "verified" in the model's result
  reply = { ok: true, method: 'paste', verified: true, attempts: 1, detail: 'inserted via paste event' };
  const v = await T.executeTool({ ...tc, id: 'rs-verified' }, 'edit', snapWith(''));
  assert.strictEqual(v._message, 'Replaced in document');
  assert.deepStrictEqual(JSON.parse(v.content), { ok: true, note: T.PASTE_DONE_NOTE });
});

test('the model\'s result of a paste says it was pasted and must not be verified or repeated', () => {
  assert.strictEqual(T.PASTE_DONE_NOTE, 'The text was pasted into the document. The document snapshot your reading tools see was taken before this paste ' +
    'and will not show it until the user\'s next message, so do not re-read to verify and do not call replace_selection again for this text.');
});

test('one paste per turn: a second replace_selection on the same snapshot is refused without a REPLACE_SELECTION message', async () => {
  sent.length = 0; clip.length = 0; T.el.chat.children.length = 0;
  reply = { ok: true, method: 'paste', verified: false, attempts: 1, detail: '' };
  const snap = snapWith('');
  const first = await call(snap, 'Paragraph.');
  assert.strictEqual(first.content, pasteOk()); assert.strictEqual(snap.pasteDone, true);
  const second = await call(snap, 'Paragraph.');
  assert.strictEqual(sent.length, 1); // the document was not touched
  assert.strictEqual(second._ok, false);
  assert.strictEqual(second.content, 'Error: replace_selection was already used in this message and the text was pasted; the document snapshot predates the paste, ' +
    'so reading tools cannot show it. Do not paste again; if more changes are needed, say so in the chat and the user will send a new message.');
  assert.strictEqual(second._message, 'Not pasted again (already pasted once in this message)');
  assert.strictEqual(second._pasteRefused, true);
  assert.deepStrictEqual(clip, []);
  // a new turn (a new snapshot) pastes again
  const next = await call(snapWith(''), 'Other.');
  assert.ok(next._ok); assert.strictEqual(sent.length, 2);
  // a paste that failed does not count: the model is told not to call again, but nothing was pasted
  reply = { ok: false, error: 'paste event not handled' };
  const s2 = snapWith('');
  const failed = await call(s2, 'x');
  assert.strictEqual(failed._ok, false); assert.ok(!s2.pasteDone);
});
