'use strict';
// The Files box against texts stored under it: remember, the first-run pass or another tab changing MAIN.md / DOC.md
// while the user types. The box is compared with the text it was opened with (its base), never with the latest
// stored text, so a stored line is never written away: a typed edit is merged onto it, or dropped with a notice.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { load, installDocTab } = require('./lib/sandbox');
const { sharedStorage, tick } = require('./lib/shared-storage');

const KEY = 'muninDocInstructions:DOC123';
const MAIN = 'muninMainInstructions';
let env, T, state, storage;
const snap = () => { const s = T.takeSnapshot(); T.snapshotDocument(s); return s; };
const remember = (args) => T.executeTool({ id: 'r', type: 'function', function: { name: 'remember', arguments: JSON.stringify(args) } }, 'edit', snap(), {});
const setDoc = (t) => { if (t) storage[KEY] = t; else delete storage[KEY]; state.docInstructions = t; };
const note = () => (T.el.filesPaneNote.classList.contains('hidden') ? '' : T.el.filesPaneNote.textContent);
const type = (text) => { T.el.instructionsText.value = text; T.onInstructionsInput(); };

before(async () => {
  env = await load();
  ({ T, state, storage } = env);
  installDocTab(env);
  await T.refreshContext({ force: true });
  assert.strictEqual(state.docId, 'DOC123');
});

test('mergeInstructions: separate blocks both apply, insertions at one place keep both, overlaps refuse', () => {
  const m = (b, mine, theirs) => T.mergeInstructions(b, mine, theirs);
  assert.strictEqual(m('A', 'A\nmine', 'A\nB'), 'A\nB\nmine'); // both appended: theirs first
  assert.strictEqual(m('A\nB\nC', 'A2\nB\nC', 'A\nB\nC\nD'), 'A2\nB\nC\nD');
  assert.strictEqual(m('A\nB\nC', 'A\nB\nC\nmine', 'A\nC'), 'A\nC\nmine'); // theirs removed B
  assert.strictEqual(m('A\nB\nC', 'A\nB\nC2', 'A0\nB\nC'), 'A0\nB\nC2');
  assert.strictEqual(m('A', 'A more', 'A\nB'), 'A more\nB'); // typing in the last line, a line appended
  assert.strictEqual(m('A\nB', 'A\nB2', 'A\nB3'), null); // the same line changed on both sides
  assert.strictEqual(m('A\nB\nC', 'A\nX\nB\nC', 'A\nC'), 'A\nX\nC'); // an insertion next to a removal
  assert.strictEqual(m('A\nB\nC\nD', 'A\nB\nX\nC\nD', 'A\nD'), null); // an insertion inside a removal
  assert.strictEqual(m('A', 'A', 'A\nB'), 'A\nB'); // no edit: theirs
  assert.strictEqual(m('A', 'A\nB', 'A\nB'), 'A\nB'); // the same edit
});

test('typing while remember adds a line: the save keeps both lines and says so', async () => {
  setDoc('Use British English.');
  T.openFiles('document');
  assert.strictEqual(T.el.instructionsText.value, 'Use British English.');
  type('Use British English.\nKeep the term "lipid raft".');
  const r = await remember({ scope: 'document', action: 'add', text: 'Target journal: Nature.' });
  assert.strictEqual(r._ok, true);
  assert.strictEqual(storage[KEY], 'Use British English.\nTarget journal: Nature.');
  assert.strictEqual(T.el.instructionsText.value, 'Use British English.\nKeep the term "lipid raft".'); // the typing stays
  await T.saveInstructions();
  assert.strictEqual(storage[KEY], 'Use British English.\nTarget journal: Nature.\nKeep the term "lipid raft".');
  assert.strictEqual(state.docInstructions, storage[KEY]);
  assert.strictEqual(T.el.instructionsText.value, storage[KEY]); // the box shows the merged text
  assert.match(note(), /your edit was added/);
  // the next save writes nothing new; typing hides the notice
  await T.saveInstructions();
  assert.strictEqual(storage[KEY], 'Use British English.\nTarget journal: Nature.\nKeep the term "lipid raft".');
  type(T.el.instructionsText.value);
  assert.strictEqual(note(), '');
  T.closeFiles();
  await tick(5);
});

test('an edit that clashes with the stored change is not saved: the stored text shows with a notice', async () => {
  setDoc('Use British English.\nAnswer briefly.');
  T.openFiles('document');
  type('Use British English.\nAnswer at length.');
  await remember({ scope: 'document', action: 'replace', old: 'Answer briefly.', text: 'Answer in two sentences.' });
  await T.saveInstructions();
  assert.strictEqual(storage[KEY], 'Use British English.\nAnswer in two sentences.');
  assert.strictEqual(T.el.instructionsText.value, 'Use British English.\nAnswer in two sentences.');
  assert.match(note(), /your last edit was not saved/);
  T.closeFiles();
  await tick(5);
  assert.strictEqual(storage[KEY], 'Use British English.\nAnswer in two sentences.'); // closing writes nothing over it
  assert.strictEqual(note(), '');
});

test('nothing typed: a stored change shows in the box at once, the timer pending or not', async () => {
  setDoc('A');
  T.openFiles('document');
  await remember({ scope: 'document', action: 'add', text: 'B' });
  assert.strictEqual(T.el.instructionsText.value, 'A\nB');
  T.onInstructionsInput(); // a stray input event (focus, IME) with the same text
  await remember({ scope: 'document', action: 'add', text: 'C' });
  assert.strictEqual(T.el.instructionsText.value, 'A\nB\nC');
  await T.saveInstructions();
  assert.strictEqual(storage[KEY], 'A\nB\nC');
  T.closeFiles();
  await tick(5);
  // MAIN.md the same way
  storage[MAIN] = 'M'; state.mainInstructions = 'M';
  T.openFiles('main');
  type('M\nmine');
  await remember({ scope: 'main', action: 'add', text: 'N' });
  T.closeFiles(); // the close saves (merging)
  await tick(5);
  assert.strictEqual(storage[MAIN], 'M\nN\nmine');
});

test('across tabs: a line stored by another tab while this one types is kept', async () => {
  const store = sharedStorage();
  const mk = async () => {
    const e = await load();
    store.attach(e);
    installDocTab(e);
    await e.T.refreshContext({ force: true });
    e.T.watchInstructionsStorage();
    return e;
  };
  const A = await mk();
  const B = await mk();
  await A.T.writeDocInstructions('DOC123', 'Rule one.');
  await tick(5);
  assert.strictEqual(B.state.docInstructions, 'Rule one.');
  A.T.openFiles('document');
  A.T.el.instructionsText.value = 'Rule one.\nTyped in A.';
  A.T.onInstructionsInput();
  await B.T.writeDocInstructions('DOC123', 'Rule one.\nFrom B.');
  await tick(5);
  assert.strictEqual(A.state.docInstructions, 'Rule one.\nFrom B.'); // followed
  assert.strictEqual(A.T.el.instructionsText.value, 'Rule one.\nTyped in A.'); // the typing stays
  await A.T.saveInstructions();
  assert.strictEqual(store.items[KEY], 'Rule one.\nFrom B.\nTyped in A.');
  await tick(5);
  assert.strictEqual(B.state.docInstructions, 'Rule one.\nFrom B.\nTyped in A.');
  A.T.closeFiles();
  await tick(5);
  assert.strictEqual(store.items[KEY], 'Rule one.\nFrom B.\nTyped in A.');
});
