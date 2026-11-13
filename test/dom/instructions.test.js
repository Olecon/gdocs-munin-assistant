'use strict';
// The Files panel on jsdom: the header button opens a list of MAIN.md, DOC.md and the document's attached files (no
// placeholder without files), each row with its last-modified date; an entry opens in place of the list (the
// instructions box with autosave per file, or a read-only viewer of a file's numbered lines) and + Add file turns into
// Close, which goes back to the list; Remove asks first and deletes the text, the bytes and the entry; Add
// file uses the composer's picker and stores the files with the document; without a document DOC.md and Add file are
// off; another tab's change reaches the list and the open box; the section still closes on a press outside.
const { test } = require('node:test');
const assert = require('node:assert');
const { load, click, typeInto, pointer, tick } = require('../lib/dom-sandbox');
const { installDocTab, waitFor } = require('../lib/sandbox');
const { sharedStorage } = require('../lib/shared-storage');

const KEY = 'muninDocInstructions:DOC123';
const MAIN = 'muninMainInstructions';
const FILES = 'muninFiles:DOC123';
const NOTES = '# Notes\n\nFirst point.';
const STORED_FILES = {
  [FILES]: [{ alias: 'doc2', title: 'notes.md', lines: 3, size: 21, addedAt: 1 }, { alias: 'doc3', title: 'paper.pdf', lines: 4, pages: 2, size: 90000, addedAt: 2 }],
  'muninAttach:DOC123:doc2': { name: 'notes.md', format: 'markdown', text: NOTES },
  'muninAttach:DOC123:doc3': { name: 'paper.pdf', format: 'pdf', text: '[page 1]\nOne.\n[page 2]\nTwo.' },
};

async function withDoc(storage = {}) {
  const env = await load({ storage });
  installDocTab(env);
  env.chrome.tabs.sendMessage = async (id, msg) => (msg.type === 'GET_DOC_TEXT'
    ? { ok: true, text: '# My Doc\n\nThe quick brown fox.', format: 'markdown', title: 'My Doc' }
    : msg.type === 'GET_SELECTION' ? { ok: true, text: '' } : { ok: true, title: 'My Doc' });
  await env.T.refreshContext({ force: true });
  assert.strictEqual(env.state.docId, 'DOC123');
  return env;
}
const rows = (env) => [...env.el.filesList.querySelectorAll('.file-row')].map((r) => [r.querySelector('.file-name').textContent, r.querySelector('.file-meta').textContent]);
const entry = (env, e) => env.el.filesList.querySelector(`[data-entry="${e}"] .file-open`);
const dates = (env) => [...env.el.filesList.querySelectorAll('.file-row')].map((r) => r.querySelector('.file-date').textContent);
const viewerLines = (env) => [...env.el.fileViewer.querySelectorAll('.fv-line')].map((l) => [l.dataset.n, l.textContent]);

test('with a document: the list shows MAIN.md, DOC.md and the files; each opens in place of the list, Close goes back; autosave per file', async () => {
  const env = await withDoc({ [KEY]: 'Use British English.', [MAIN]: 'Answer briefly.\nUse SI units.', ...STORED_FILES });
  const { el, state, storage, document } = env;
  await waitFor(() => state.mainInstructions === 'Answer briefly.\nUse SI units.', 'the main instructions loaded');
  assert.strictEqual(document.getElementById('docInitRun'), null); // no Write from the document
  click(el.filesBtn);
  assert.ok(!el.files.classList.contains('hidden') && el.filesPane.classList.contains('hidden'));
  assert.deepStrictEqual(rows(env), [['MAIN.md', 'Every document · 2 lines'], ['DOC.md', 'This document · 1 line'],
    ['notes.md', '21 B · doc2'], ['paper.pdf', '2 pages · doc3']]);
  assert.ok(el.filesList.querySelectorAll('.file-row')[2].querySelector('.file-remove')); // files can be removed, MAIN.md and DOC.md not
  assert.ok(!el.filesList.querySelectorAll('.file-row')[0].querySelector('.file-remove'));
  assert.strictEqual(el.filesList.getAttribute('role'), 'list');
  assert.strictEqual(el.filesAdd.textContent, '+ Add file');
  // MAIN.md: the box in place of the list; + Add file reads Close
  click(entry(env, 'main'));
  assert.ok(!el.filesPane.classList.contains('hidden') && !el.instructionsText.classList.contains('hidden') && el.fileViewer.classList.contains('hidden'));
  assert.ok(el.filesList.classList.contains('hidden'));
  assert.deepStrictEqual([el.filesAdd.textContent, el.filesAdd.dataset.tip, el.filesAdd.disabled], ['Close', 'Back to the list', false]);
  assert.strictEqual(document.getElementById('filesPaneClose'), null); // no Close of its own in the pane
  assert.strictEqual(el.instructionsText.value, 'Answer briefly.\nUse SI units.');
  assert.strictEqual(el.instructionsText.getAttribute('aria-label'), 'MAIN.md');
  assert.strictEqual(el.filesPaneName.textContent, 'MAIN.md · every document');
  assert.strictEqual(el.filesList.querySelector('.file-row.active').dataset.entry, 'main');
  assert.strictEqual(entry(env, 'main').getAttribute('aria-current'), 'true');
  // autosave on the main key after the pause
  typeInto(el.instructionsText, 'Answer briefly.\nRun agents on gpt-5-mini.');
  await tick(500);
  assert.strictEqual(storage[MAIN], 'Answer briefly.\nUse SI units.');
  await waitFor(() => storage[MAIN] === 'Answer briefly.\nRun agents on gpt-5-mini.', 'the main save after the pause');
  // typed text waiting for the pause is saved by Close, to the file it was typed in
  typeInto(el.instructionsText, 'Run agents on gpt-5-mini.');
  click(el.filesAdd);
  assert.ok(el.filesPane.classList.contains('hidden') && !el.filesList.classList.contains('hidden'));
  assert.strictEqual(el.filesAdd.textContent, '+ Add file');
  await waitFor(() => storage[MAIN] === 'Run agents on gpt-5-mini.', 'the save on Close');
  click(entry(env, 'document'));
  assert.strictEqual(el.instructionsText.value, 'Use British English.');
  assert.strictEqual(el.instructionsText.getAttribute('aria-label'), 'DOC.md');
  typeInto(el.instructionsText, 'Use American English.');
  await waitFor(() => storage[KEY] === 'Use American English.' && state.docInstructions === 'Use American English.', 'the document save');
  assert.strictEqual(rows(env)[1][1], 'This document · 1 line');
  // a file: the read-only viewer of its numbered lines (what the model reads), selectable text
  click(el.filesAdd);
  click(entry(env, 'doc3'));
  assert.ok(el.instructionsText.classList.contains('hidden') && !el.fileViewer.classList.contains('hidden'));
  await waitFor(() => viewerLines(env).length === 4, 'the viewer');
  assert.deepStrictEqual(viewerLines(env), [['1', '[page 1]'], ['2', 'One.'], ['3', '[page 2]'], ['4', 'Two.']]);
  assert.strictEqual(el.filesPaneName.textContent, 'paper.pdf · doc3 · 4 lines');
  assert.strictEqual(el.fileViewer.querySelector('textarea, input'), null); // read-only
  assert.strictEqual(document.activeElement, el.fileViewer); // the keyboard focus moves from the hidden row
  // Close goes back to the list, nothing open
  click(el.filesAdd);
  assert.ok(el.filesPane.classList.contains('hidden') && !el.filesList.classList.contains('hidden'));
  assert.strictEqual(el.filesList.querySelector('.file-row.active'), null);
  click(entry(env, 'doc2'));
  await waitFor(() => viewerLines(env).length === 3, 'the second viewer');
  assert.deepStrictEqual(viewerLines(env), [['1', '# Notes'], ['2', ''], ['3', 'First point.']]);
  click(el.filesAdd);
  assert.ok(!el.files.classList.contains('hidden')); // the section stays open
  // the redrawn list keeps the keyboard focus on its row
  entry(env, 'doc2').focus();
  env.T.renderFilesList();
  assert.strictEqual(document.activeElement, entry(env, 'doc2'));
  click(el.filesBtn);
  assert.ok(el.files.classList.contains('hidden'));
  assert.deepStrictEqual(Object.keys(storage).filter((k) => /instruction/i.test(k)).sort(),
    [KEY, MAIN, 'muninDocInstructionsAt:DOC123', 'muninMainInstructionsAt'].sort());
  env.close();
});

test('without a document: DOC.md is off, no files and Add file is off; MAIN.md saves', async () => {
  const env = await load({ storage: { [MAIN]: 'Answer briefly.' } });
  const { el, state, storage } = env;
  assert.strictEqual(state.docId, null);
  await waitFor(() => state.mainInstructions === 'Answer briefly.', 'the main instructions loaded');
  click(el.filesBtn);
  assert.ok(!el.files.classList.contains('hidden'));
  assert.deepStrictEqual(rows(env), [['MAIN.md', 'Every document · 1 line'], ['DOC.md', 'No document']]);
  assert.ok(entry(env, 'document').disabled && el.filesAdd.disabled);
  assert.strictEqual(el.filesAdd.dataset.tip, 'Open a document first');
  assert.strictEqual(el.filesList.children.length, 2); // no placeholder
  assert.ok(!/attach/i.test(el.filesList.textContent));
  click(entry(env, 'document')); // disabled: nothing happens
  assert.ok(el.filesPane.classList.contains('hidden'));
  click(entry(env, 'main'));
  assert.strictEqual(el.instructionsText.value, 'Answer briefly.');
  assert.ok(!el.filesAdd.disabled && el.filesAdd.textContent === 'Close'); // Close works without a document
  typeInto(el.instructionsText, '');
  pointer(el.chat, 'pointerdown'); // a press outside closes and saves
  assert.ok(el.files.classList.contains('hidden'));
  await waitFor(() => !(MAIN in storage) && state.mainInstructions === '', 'the empty text removes the key');
  env.close();
});

test('Remove asks first; it deletes the text, the bytes and the entry; an open viewer closes; Cancel keeps the file', async () => {
  const env = await withDoc({ ...STORED_FILES });
  const { el, state, storage } = env;
  env.idb.dbs.set('munin-files', new Map([['files', new Map([['DOC123:doc2', { name: 'notes.md' }], ['DOC123:doc3', { name: 'paper.pdf' }]])]]));
  click(env.el.filesBtn);
  click(entry(env, 'doc2'));
  click(el.filesAdd); // back to the list
  const removeBtn = (alias) => el.filesList.querySelector(`[data-entry="${alias}"] .file-remove`);
  assert.strictEqual(removeBtn('doc2').getAttribute('aria-label'), 'Remove notes.md');
  click(removeBtn('doc3'));
  const confirm = () => el.filesList.querySelector('.file-confirm');
  assert.strictEqual(confirm().querySelector('span').textContent, 'Remove paper.pdf? No chat can read it then.');
  click([...confirm().querySelectorAll('button')].find((b) => b.textContent === 'Cancel'));
  assert.strictEqual(confirm(), null);
  assert.ok(storage['muninAttach:DOC123:doc3']);
  click(removeBtn('doc2'));
  click([...confirm().querySelectorAll('button')].find((b) => b.textContent === 'Remove'));
  await waitFor(() => !('muninAttach:DOC123:doc2' in storage), 'the text removed');
  assert.deepStrictEqual(storage[FILES].map((f) => f.alias), ['doc3']);
  assert.deepStrictEqual(Array.from(state.docFiles, (f) => f.alias), ['doc3']);
  await waitFor(() => !env.idb.dbs.get('munin-files').get('files').has('DOC123:doc2'), 'the bytes removed');
  assert.ok(env.idb.dbs.get('munin-files').get('files').has('DOC123:doc3'));
  // the list is drawn again after the removal settles (its storage event may come a tick later)
  await waitFor(() => rows(env).map((r) => r[0]).join() === 'MAIN.md,DOC.md,paper.pdf', 'the list without notes.md');
  // a file removed while its viewer is open (another tab): back to the list
  click(entry(env, 'doc3'));
  await env.T.removeDocFile('DOC123', 'doc3');
  assert.ok(el.filesPane.classList.contains('hidden') && !el.filesList.classList.contains('hidden'));
  assert.strictEqual(el.filesAdd.textContent, '+ Add file');
  assert.deepStrictEqual(rows(env).map((r) => r[0]), ['MAIN.md', 'DOC.md']);
  env.close();
});

test('Add file: the composer\'s picker; the file is listed while read, then stored with the document (no chip)', async () => {
  const env = await withDoc();
  const { el, state, storage, document, window } = env;
  const input = document.getElementById('attachInput');
  let opened = 0;
  input.click = () => { opened++; };
  click(el.filesBtn);
  assert.strictEqual(el.filesList.children.length, 2); // MAIN.md and DOC.md, no placeholder
  assert.strictEqual(el.filesList.querySelector('.files-empty'), null);
  assert.ok(!el.filesAdd.disabled);
  assert.strictEqual(el.filesAdd.textContent, '+ Add file');
  click(el.filesAdd);
  assert.strictEqual(opened, 1);
  assert.ok(!el.files.classList.contains('hidden')); // the section stays open
  Object.defineProperty(input, 'files', { configurable: true, value: [new window.File(['Line one\nLine two'], 'data.csv', { type: 'text/csv' })] });
  input.dispatchEvent(new window.Event('change'));
  assert.deepStrictEqual(rows(env).slice(2), [['data.csv', 'reading…']]);
  await waitFor(() => storage[FILES] && storage[FILES].length === 1, 'the file stored');
  assert.deepStrictEqual(storage[FILES].map(({ addedAt, ...f }) => f), [{ alias: 'doc2', title: 'data.csv', lines: 2, size: 17 }]);
  assert.deepStrictEqual(storage['muninAttach:DOC123:doc2'], { name: 'data.csv', format: 'text', text: 'Line one\nLine two' });
  await waitFor(() => rows(env).length === 3 && rows(env)[2][1] === '17 B · doc2', 'the row');
  assert.strictEqual(document.querySelectorAll('#attachRow .attach-chip').length, 0);
  assert.strictEqual(env.T.attachState.target, 'chat'); // the composer's + adds chips again
  // the next turn of any chat lists it
  const snap = env.T.takeSnapshot(); env.T.snapshotDocument(snap);
  assert.ok(env.T.buildTurnContext('edit', snap, null).includes('doc2 "data.csv" (file) (2 lines)'));
  assert.deepStrictEqual(Array.from(state.docFiles, (f) => f.alias), ['doc2']);
  env.close();
});

test('dates: every row shows its last-modified date like a file explorer; a save in the box stores its time', async () => {
  const at = (...a) => new Date(...a).getTime(); // local time, like the panel
  const NOW = at(2026, 9, 30, 15, 0);
  const env = await withDoc({ [KEY]: 'Use British English.', [MAIN]: 'Answer briefly.', muninMainInstructionsAt: at(2026, 9, 30, 14, 2),
    [FILES]: [{ alias: 'doc2', title: 'notes.md', lines: 3, size: 21, addedAt: at(2026, 9, 3, 9, 0) },
      { alias: 'doc3', title: 'old.txt', lines: 1, size: 5, addedAt: at(2025, 9, 30, 8, 0) }],
    'muninAttach:DOC123:doc2': { name: 'notes.md', format: 'markdown', text: NOTES },
    'muninAttach:DOC123:doc3': { name: 'old.txt', format: 'text', text: 'Old.' } });
  const { el, storage } = env;
  env.run(`Date.now = () => ${NOW}`);
  click(el.filesBtn);
  await waitFor(() => dates(env)[0] === '14:02', 'the stored time of MAIN.md');
  // today: the time; this year: day and month; earlier: with the year; DOC.md has no stored time (an earlier build)
  assert.deepStrictEqual(dates(env), ['14:02', '', '3 Oct', '30 Oct 2025']);
  assert.strictEqual(el.filesList.querySelector('.file-date').dataset.tip, '30 Oct 2026, 14:02');
  assert.strictEqual(el.filesList.querySelectorAll('.file-date')[1].dataset.tip, undefined);
  // a save in the box stores the time next to the text
  click(entry(env, 'document'));
  typeInto(el.instructionsText, 'Use American English.');
  click(el.filesAdd);
  await waitFor(() => storage['muninDocInstructionsAt:DOC123'] === NOW, 'the save time');
  assert.strictEqual(storage[KEY], 'Use American English.');
  await waitFor(() => dates(env)[1] === '15:00', 'the new date in the list');
  assert.deepStrictEqual(dates(env), ['14:02', '15:00', '3 Oct', '30 Oct 2025']);
  // emptying the text is a save too
  env.run(`Date.now = () => ${NOW + 60000}`);
  click(entry(env, 'document'));
  typeInto(el.instructionsText, '');
  click(el.filesAdd);
  await waitFor(() => storage['muninDocInstructionsAt:DOC123'] === NOW + 60000, 'the time of the emptying save');
  assert.ok(!(KEY in storage));
  await waitFor(() => dates(env)[1] === '15:01', 'the date of the emptying save');
  // the format at the edges of a day and a year
  assert.strictEqual(env.T.fileDate(at(2026, 0, 1, 0, 5), at(2026, 0, 1, 23, 59)), '00:05');
  assert.strictEqual(env.T.fileDate(at(2025, 11, 31, 23, 59), at(2026, 0, 1, 0, 1)), '31 Dec 2025');
  assert.strictEqual(env.T.fileDate(at(2026, 0, 31, 12, 0), at(2026, 1, 1, 12, 0)), '31 Jan');
  assert.strictEqual(env.T.fileDate(undefined), '');
  env.close();
});

test('the viewer draws a long file in parts: 5,000 lines, then "Show N more lines"', async () => {
  const text = Array.from({ length: 5003 }, (_, i) => `line ${i + 1}`).join('\n');
  const env = await withDoc({ [FILES]: [{ alias: 'doc2', title: 'big.txt', lines: 5003, size: 50000, addedAt: 1 }],
    'muninAttach:DOC123:doc2': { name: 'big.txt', format: 'text', text } });
  click(env.el.filesBtn);
  click(entry(env, 'doc2'));
  await waitFor(() => viewerLines(env).length === 5000, 'the first part');
  const more = env.el.fileViewer.querySelector('.fv-more');
  assert.strictEqual(more.textContent, 'Show 3 more lines');
  click(more);
  assert.strictEqual(viewerLines(env).length, 5003);
  assert.deepStrictEqual(viewerLines(env).at(-1), ['5003', 'line 5003']);
  assert.strictEqual(env.el.fileViewer.querySelector('.fv-more'), null);
  env.close();
});

test('no badge: the Files button has no dot and no tooltip', async () => {
  const env = await withDoc({ [KEY]: 'Use British English.' });
  const { el, state, document } = env;
  await waitFor(() => state.docInstructions === 'Use British English.', 'the document instructions loaded');
  assert.strictEqual(document.getElementById('instructionsDot'), null);
  assert.strictEqual(el.filesBtn.querySelector('.badge-dot'), null);
  assert.strictEqual(el.filesBtn.dataset.tip, undefined);
  env.close();
});

test('another tab: a change of MAIN.md, DOC.md or the files reaches the state, the list and the open box', async () => {
  const store = sharedStorage();
  const panel = async () => {
    const env = await load();
    store.attach(env);
    installDocTab(env);
    env.chrome.tabs.sendMessage = async () => ({ ok: true, title: 'My Doc' });
    await env.T.refreshContext({ force: true });
    return env;
  };
  const a = await panel();
  const b = await panel();
  click(b.el.filesBtn);
  click(entry(b, 'main'));
  click(a.el.filesBtn);
  click(entry(a, 'main'));
  typeInto(a.el.instructionsText, 'Answer briefly.');
  click(a.el.filesBtn); // closing saves
  await waitFor(() => b.state.mainInstructions === 'Answer briefly.', 'the main instructions in the other tab');
  assert.strictEqual(b.el.instructionsText.value, 'Answer briefly.');
  click(a.el.filesBtn);
  click(entry(a, 'document'));
  typeInto(a.el.instructionsText, 'Use British English.');
  click(a.el.filesBtn);
  await waitFor(() => b.state.docInstructions === 'Use British English.', 'the document instructions in the other tab');
  assert.strictEqual(b.el.instructionsText.value, 'Answer briefly.'); // its box still shows MAIN.md
  assert.strictEqual(rows(b)[1][1], 'This document · 1 line');
  await waitFor(() => /^\d\d:\d\d$/.test(dates(b)[1]), 'the save time of DOC.md in the other tab'); // b drew its list before the save
  // a file added in one tab is listed in the other
  const item = { name: 'n.md', size: 2, type: '', bytes: new Uint8Array([1, 2]), result: { text: 'hi', format: 'markdown', lines: 1 } };
  await a.T.storeDocFiles('DOC123', [item]);
  await waitFor(() => b.state.docFiles.length === 1, 'the file in the other tab');
  assert.deepStrictEqual(rows(b)[2], ['n.md', '2 B · doc2']);
  a.close(); b.close();
});
