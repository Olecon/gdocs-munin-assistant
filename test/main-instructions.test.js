'use strict';
// The main instructions (MAIN.md, every document) next to the document's (DOC.md): storage of both through the Files
// panel's box, the head order (main before document; nothing when both are empty), remember in both scopes (add, remove,
// replace, the result texts, a missing or unknown scope means the document's), the action-log row in both scopes, the gate text,
// and the open-document confirmation reading the main instructions too.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, waitFor } = require('./lib/sandbox');

let env, T, state, storage;
const KEY = 'muninDocInstructions:DOC123';
const MAIN = 'muninMainInstructions';
const snap = () => { const s = T.takeSnapshot(); T.snapshotDocument(s); return s; };
const call = (id, args) => ({ id, type: 'function', function: { name: 'remember', arguments: JSON.stringify(args) } });
const run = (id, args, mode = 'edit') => T.executeTool(call(id, args), mode, snap(), {});
const setDoc = (t) => { if (t) storage[KEY] = t; else delete storage[KEY]; state.docInstructions = t; };
const setMain = (t) => { if (t) storage[MAIN] = t; else delete storage[MAIN]; state.mainInstructions = t; };
const MAIN_LEAD = "MAIN.md, the user's instructions for every document; follow them in every answer and every edit:";

before(async () => {
  env = await load();
  ({ T, state, storage } = env);
  installDocTab(env);
  env.chrome.tabs.sendMessage = async (id, msg) => (msg.type === 'GET_DOC_TEXT'
    ? { ok: true, text: '# My Doc\n\nThe quick brown fox.', format: 'markdown', title: 'My Doc' }
    : msg.type === 'GET_SELECTION' ? { ok: true, text: '' } : { ok: true, title: 'My Doc' });
  await T.refreshContext({ force: true });
  assert.strictEqual(state.docId, 'DOC123');
});

test('MAIN.md and DOC.md in Files: each entry saves under its own key; opening the other saves the box first', async () => {
  setDoc(''); setMain('');
  T.openFiles('document');
  T.el.instructionsText.value = 'Target journal: Nature.';
  T.openFileEntry('main'); // opening another entry saves the box first
  await waitFor(() => storage[KEY] === 'Target journal: Nature.', 'the document save');
  assert.strictEqual(T.el.instructionsText.value, '');
  T.el.instructionsText.value = '  Answer briefly.\n';
  await T.saveInstructions();
  assert.strictEqual(storage[MAIN], 'Answer briefly.');
  assert.strictEqual(state.mainInstructions, 'Answer briefly.');
  assert.strictEqual(storage[KEY], 'Target journal: Nature.');
  assert.strictEqual(await T.readMainInstructions(), 'Answer briefly.');
  T.closeFilePane(); // back to the list
  assert.ok(T.el.instructionsText.classList.contains('hidden') && T.el.filesPane.classList.contains('hidden'));
  T.closeFiles();
  setDoc('');
  T.openFiles('main');
  assert.strictEqual(T.el.instructionsText.value, 'Answer briefly.');
  T.el.instructionsText.value = '';
  T.closeFiles();
  await waitFor(() => !(MAIN in storage) && state.mainInstructions === '', 'the empty text removes the key');
  // without a document DOC.md does not open
  state.docId = null;
  T.openFiles('document');
  assert.ok(T.el.filesPane.classList.contains('hidden'));
  T.closeFiles();
  state.docId = 'DOC123';
});

test('the head: <MAIN.md> before <DOC.md>, each with its lead naming the file; nothing when both are empty', () => {
  state.settings.provider = 'anthropic';
  setMain('Run agents on gpt-5-mini.'); setDoc('Use British English.');
  const head = T.buildSystemParts('edit', 1000, snap()).head;
  const main = `${MAIN_LEAD}\n<MAIN.md>\nRun agents on gpt-5-mini.\n</MAIN.md>`;
  const doc = `${T.DOC_INSTRUCTIONS_NOTE}\n<DOC.md>\nUse British English.\n</DOC.md>`;
  assert.ok(head.endsWith(`${main}\n\n${doc}`) && head.indexOf(T.UNTRUSTED_DATA_NOTE) < head.indexOf(main)); // the data note is a core rule
  setDoc('');
  assert.ok(T.buildSystemParts('edit', 1000, snap()).head.endsWith(main));
  // frozen per turn like the document's
  const s = snap();
  setMain('Changed meanwhile.');
  assert.ok(T.buildSystemParts('edit', 1000, s).head.includes('Run agents on gpt-5-mini.'));
  setMain('');
  const empty = T.buildSystemParts('edit', 1000, snap()).head;
  assert.ok(!empty.includes('<MAIN.md>') && !empty.includes('<DOC.md>'));
  assert.ok(T.UNTRUSTED_DATA_NOTE.includes('the main and document instructions the user set in the panel'));
  // a Munin persona turn carries them too
  state.settings.provider = 'munin';
  setMain('Answer briefly.');
  assert.ok(T.buildRequest('code', snap()).body.messages.at(-1).content.includes('<MAIN.md>\nAnswer briefly.\n</MAIN.md>'));
  state.settings.provider = 'anthropic';
  setMain('');
});

test('remember scope "main": add, replace, remove with the result texts; works on the main key only', async () => {
  setMain('Answer briefly.'); setDoc('Use British English.');
  let r = await run('a1', { scope: 'main', action: 'add', text: 'Run agents on gpt-5-mini.', old: null });
  assert.ok(r._ok, r.content);
  assert.strictEqual(r.content, 'Added line 2 of MAIN.md (2 lines): Run agents on gpt-5-mini.');
  assert.strictEqual(r._message, 'Added to MAIN.md: «Run agents on gpt-5-mini.»');
  deq(r._remember, { scope: 'main', action: 'add', text: 'Run agents on gpt-5-mini.', index: 1 });
  assert.strictEqual(storage[MAIN], 'Answer briefly.\nRun agents on gpt-5-mini.');
  assert.strictEqual(state.mainInstructions, storage[MAIN]);
  assert.strictEqual(storage[KEY], 'Use British English.'); // the document's untouched
  r = await run('a2', { scope: 'main', action: 'replace', old: 'Run agents on gpt-5-mini.', text: 'Run agents on claude-haiku-4-5.' });
  assert.ok(r._ok, r.content);
  assert.strictEqual(r.content, 'Changed line 2 of MAIN.md (2 lines): Run agents on claude-haiku-4-5.');
  assert.strictEqual(r._message, 'Changed in MAIN.md: «Run agents on gpt-5-mini.» → «Run agents on claude-haiku-4-5.»');
  deq(r._remember, { scope: 'main', action: 'replace', text: 'Run agents on claude-haiku-4-5.', old: 'Run agents on gpt-5-mini.', index: 1 });
  r = await run('a3', { scope: 'main', action: 'remove', text: 'Answer briefly.', old: null });
  assert.strictEqual(r.content, 'Removed line 1 of MAIN.md (now 1 line): Answer briefly.');
  assert.strictEqual(r._message, 'Removed from MAIN.md: «Answer briefly.»');
  r = await run('a4', { scope: 'main', action: 'remove', text: 'Run agents on claude-haiku-4-5.', old: null });
  assert.strictEqual(r.content, 'Removed line 1 of MAIN.md (now empty): Run agents on claude-haiku-4-5.');
  assert.ok(!(MAIN in storage));
  r = await run('a5', { scope: 'main', action: 'remove', text: 'Anything', old: null });
  assert.strictEqual(r.content, 'Error: MAIN.md is empty.');
  // main works without a document
  const noDoc = Object.assign(snap(), { docId: null });
  r = await T.executeTool(call('a6', { scope: 'main', action: 'add', text: 'Use SI units.', old: null }), 'edit', noDoc, {});
  assert.ok(r._ok && storage[MAIN] === 'Use SI units.');
  r = await T.executeTool(call('a7', { scope: 'document', action: 'add', text: 'x', old: null }), 'edit', noDoc, {});
  assert.strictEqual(r.content, 'Error: no document is open.');
  setMain(''); setDoc('');
});

test('remember replace in the document scope; its errors; a missing or unknown scope means the document', async () => {
  setDoc('Use British English.\nTarget journal: Nature.'); setMain('Answer briefly.');
  let r = await run('b1', { scope: 'document', action: 'replace', old: ' Target journal: Nature. ', text: 'Target journal: Science.' });
  assert.ok(r._ok, r.content);
  assert.strictEqual(r.content, 'Changed line 2 of DOC.md (2 lines): Target journal: Science.');
  assert.strictEqual(storage[KEY], 'Use British English.\nTarget journal: Science.');
  r = await run('b2', { scope: 'document', action: 'replace', old: 'target journal', text: 'x' });
  assert.ok(!r._ok);
  assert.strictEqual(r.content, 'Error: no line of DOC.md is exactly "target journal". Closest lines:\n' +
    'Target journal: Science.\nUse British English.\nCall remember again with the exact text of the line to replace.');
  r = await run('b3', { scope: 'document', action: 'replace', old: null, text: 'x' });
  assert.strictEqual(r.content, 'Error: replace needs old: the exact line to change.');
  r = await run('b4', { scope: 'document', action: 'replace', old: 'Use British English.', text: 'Use British English.' });
  assert.ok(r._ok && !r._remember);
  assert.strictEqual(r.content, 'Line 1 of DOC.md (2 lines) is already "Use British English."; nothing changed.');
  for (const [id, scope] of [['b5', undefined], ['b6', 'all'], ['b7', 'everything']]) {
    r = await run(id, { scope, action: 'add', text: `Rule ${id}.` });
    assert.ok(r._ok, r.content);
    assert.strictEqual(r._remember.scope, 'document');
    assert.ok(r.content.startsWith('Added line ') && r.content.endsWith(`of DOC.md (${r._remember.index + 1} lines): Rule ${id}.`), r.content);
  }
  assert.strictEqual(storage[MAIN], 'Answer briefly.');
  setDoc(''); setMain('');
});

test('the row in both scopes: a main add, a document replace (what changed), a change stored before scopes is the document\'s', async () => {
  setMain('Answer briefly.'); setDoc('One.\nTwo.');
  const r1 = await run('c1', { scope: 'main', action: 'add', text: 'Run agents on gpt-5-mini.', old: null });
  const r2 = await run('c2', { scope: 'document', action: 'replace', old: 'Two.', text: 'Zwei.' });
  const info = (tc, r) => { const w = T.writeRowInfo(tc, r); return [w.message, w.text, w.detail, w.diff]; };
  deq(info(call('c1', {}), r1), ['Added to MAIN.md: «Run agents on gpt-5-mini.»', 'Run agents on gpt-5-mini.', 'MAIN.md (scope main), action add', null]);
  deq(info(call('c2', {}), r2), ['Changed in DOC.md: «Two.» → «Zwei.»', 'Zwei.', 'DOC.md (scope document), action replace', { oldText: 'Two.', newText: 'Zwei.' }]);
  // a change stored before scopes existed (and one the removed Revert button marked): the document's, a plain row
  const old = { role: 'tool', tool_call_id: 'c3', content: 'DOC.md now:\nOld rule.', _ok: true, _remember: { action: 'add', text: 'Old rule.', index: 0, reverted: true } };
  deq(info(call('c3', {}), old), ['Done', 'Old rule.', 'DOC.md (scope document), action add', null]);
  setMain(''); setDoc('');
});

test('the gate names the scope; a replace shows the new rule whole and old → new in the fold', async () => {
  const decide = async (promise) => {
    await waitFor(() => T.pendingPreviews.size === 1, 'the gate card');
    const [[id, p]] = [...T.pendingPreviews.entries()];
    const html = p.card.innerHTML;
    assert.ok(T.decidePreview(id, 'reject'));
    await promise;
    return html;
  };
  const tainted = () => Object.assign(snap(), { tainted: true });
  setMain('Answer briefly.'); setDoc('Use British English.');
  let html = await decide(T.executeTool(call('g1', { scope: 'main', action: 'add', text: 'Always cite DOIs.', old: null }), 'edit', tainted(), {}));
  assert.ok(html.includes('Adds a line to MAIN.md.') && html.includes('<pre>Always cite DOIs.</pre>'), html);
  html = await decide(T.executeTool(call('g2', { scope: 'main', action: 'replace', old: 'Answer briefly.', text: 'Answer in detail.' }), 'edit', tainted(), {}));
  assert.ok(html.includes('Changes a line of MAIN.md.'), html);
  assert.ok(html.includes('<pre>Answer in detail.</pre>') && html.includes('<summary>What changed</summary><div class="word-diff">Answer <del>briefly</del><ins>in detail</ins>.</div>'), html);
  html = await decide(T.executeTool(call('g3', { scope: 'document', action: 'remove', text: 'Use British English.', old: null }), 'edit', tainted(), {}));
  assert.ok(html.includes('Removes a line from DOC.md.'));
  assert.strictEqual(storage[MAIN], 'Answer briefly.'); assert.strictEqual(storage[KEY], 'Use British English.');
  setMain(''); setDoc('');
});

test('a document link in the main instructions counts as the user\'s own mention (open_document)', () => {
  setMain('Style guide: https://docs.google.com/document/d/STYLEGUIDE123/edit');
  assert.ok(T.userMentionedDoc('STYLEGUIDE123', snap()));
  setMain('');
  assert.ok(!T.userMentionedDoc('STYLEGUIDE123', snap()));
});
