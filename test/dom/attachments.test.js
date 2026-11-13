'use strict';
// Attached files on a real DOM (jsdom): the + button left of [/] opens the hidden file picker (accept: the text types,
// .docx, .pdf), a file dropped on the composer becomes a chip ("reading…", then its size), × removes it, and the chips go
// with the next message: the user bubble shows an "Attached:" line per file, also after a re-render from the history.
// A drop anywhere on the chat area (messages, empty state, splitter) attaches like one on the composer, with the
// composer's tint while dragging; a drop over a layer (Settings, Files, a menu, the header) attaches nothing; files
// pasted into the input attach the same way (a lone image is refused, text stays a text paste).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { load, click, typeInto, key, tick } = require('../lib/dom-sandbox');
const { installDocTab, waitFor } = require('../lib/sandbox');
const { ev, sseResponse } = require('../lib/streams');

let env, T, state, el, document, window;
const chips = () => [...document.querySelectorAll('#attachRow .attach-chip')];
const chipTexts = () => chips().map((c) => [c.querySelector('.attach-name').textContent, c.querySelector('.attach-meta').textContent]);
// A drop of files on a node (jsdom has no DataTransfer with files: the event carries a plain one).
function drop(node, files) {
  const e = new window.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'dataTransfer', { value: { files, types: ['Files'] } });
  node.dispatchEvent(e);
  return e;
}
// dragover / dragleave of a file drag (types ['text/plain']: a text drag) on a node; related: the node entered next.
function drag(type, node, related = null, types = ['Files']) {
  const e = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'dataTransfer', { value: { files: [], types, dropEffect: 'none' } });
  Object.defineProperty(e, 'relatedTarget', { value: related });
  node.dispatchEvent(e);
  return e;
}
// A paste into a node: the clipboard's files and types (a screenshot: an image.png and 'Files' only).
function paste(node, files, types) {
  const e = new window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'clipboardData', { value: { files, types } });
  node.dispatchEvent(e);
  return e;
}
const tinted = () => el.composer.classList.contains('drop-target');
const errors = () => [...el.chat.querySelectorAll('.msg.error')].map((n) => n.textContent);
const clearChips = () => chips().forEach((c) => click(c.querySelector('.attach-remove')));
const answer = (text) => ev('message_start', { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 5 } } }) +
  ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
  ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }) +
  ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
  ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }) + ev('message_stop', { type: 'message_stop' });

before(async () => {
  env = await load();
  ({ T, state, el, document, window } = env);
  installDocTab(env);
  env.chrome.tabs.sendMessage = async (id, msg) => {
    if (msg.type === 'GET_SELECTION') return { ok: true, text: '' };
    if (msg.type === 'GET_DOC_TEXT') return { ok: true, text: '# Doc\n\nSome text.', format: 'markdown', title: 'My Doc' };
    return { ok: true, title: 'My Doc' };
  };
  await T.refreshContext({ force: true });
  state.googleConnected = false;
  state.settings.provider = 'anthropic';
  Object.assign(state.settings.providers.anthropic, { apiKey: 'sk-ant-test', model: 'claude-opus-5-5' });
  env.bodies = [];
  env.ctx.fetch = async (url, init) => {
    env.bodies.push(JSON.parse(init.body));
    return sseResponse(answer('Got it.'));
  };
});
after(() => env.close());

test('the + button: left of [/], a plain button with its tooltip; it opens the hidden file picker', () => {
  const btn = document.getElementById('attachBtn');
  const input = document.getElementById('attachInput');
  deq2([...document.querySelector('.input-bar').children].slice(0, 2).map((c) => c.id), ['attachBtn', 'cmdBtn']);
  assert.strictEqual(btn.tagName, 'BUTTON');
  assert.strictEqual(btn.textContent, '+');
  assert.strictEqual(btn.dataset.tip, 'Attach a file');
  assert.ok(btn.classList.contains('cmd-btn'));
  assert.strictEqual(input.type, 'file');
  assert.ok(input.multiple && input.hidden);
  for (const a of ['.md', '.txt', '.csv', '.tsv', '.json', '.tex', '.bib', '.yaml', '.yml', '.xml', '.html', '.log', '.docx', '.pdf']) {
    assert.ok(input.accept.split(',').includes(a), a);
  }
  let opened = 0;
  input.click = () => { opened++; };
  click(btn);
  assert.strictEqual(opened, 1);
});

test('a dropped file becomes a chip ("reading…", then its size); × removes it; a dropped .doc gives an error', async () => {
  assert.ok(document.getElementById('attachRow').classList.contains('hidden'));
  const e = drop(el.composer, [new window.File(['# Notes\n\nOne.\n'], 'notes.md', { type: 'text/markdown' })]);
  assert.ok(e.defaultPrevented); // the panel page is not replaced by the file
  deq2(chipTexts(), [['notes.md', 'reading…']]);
  assert.ok(!document.getElementById('attachRow').classList.contains('hidden'));
  await waitFor(() => chipTexts()[0][1] !== 'reading…', 'the file read');
  deq2(chipTexts(), [['notes.md', '14 B']]);
  assert.strictEqual(el.action.getAttribute('aria-disabled'), 'false'); // Send is live with a file and no text
  const x = chips()[0].querySelector('.attach-remove');
  assert.strictEqual(x.getAttribute('aria-label'), 'Remove notes.md');
  click(x);
  deq2(chipTexts(), []);
  assert.ok(document.getElementById('attachRow').classList.contains('hidden'));
  drop(el.composer, [new window.File(['x'], 'old.doc')]);
  deq2(chipTexts(), []);
  assert.ok([...el.chat.querySelectorAll('.msg.error')].some((n) => n.textContent.includes('old.doc is an old Word file (.doc). Save it as .docx first.')));
  assert.strictEqual(el.chat.querySelectorAll('.notice').length, 0);
});

test('the chips go with the next message: an "Attached:" line in the bubble, kept after a re-render; the next request lists the file', async () => {
  drop(el.composer, [new window.File(['Line one\nLine two\n'], 'data.csv', { type: 'text/csv' })]);
  await waitFor(() => chipTexts().length && chipTexts()[0][1] !== 'reading…', 'the file read');
  typeInto(el.input, 'What is in it?');
  key(el.input, 'Enter');
  await waitFor(() => !state.busy && env.bodies.length === 1, 'the turn');
  await tick(5);
  deq2(chipTexts(), []);
  const bubbleLines = () => [...el.chat.querySelectorAll('.msg.user .attach-line')].map((n) => n.textContent);
  deq2(bubbleLines(), ['Attached: data.csv (3 lines)']);
  const user = state.messages.find((m) => m.role === 'user');
  deq2(user._files, [{ alias: 'doc2', title: 'data.csv', lines: 3 }]);
  assert.ok(JSON.stringify(env.bodies[0].messages).includes('doc2 \\"data.csv\\" (file) (3 lines)'));
  T.renderHistory();
  deq2(bubbleLines(), ['Attached: data.csv (3 lines)']);
});

test('the whole chat area takes a drop: a message, the empty state, the splitter; the composer is tinted while files are dragged over it', async () => {
  deq2(chipTexts(), []);
  const bubble = el.chat.querySelector('.msg.user');
  assert.ok(bubble, 'a message to drop on');
  // dragging over a message tints the composer; moving within the area keeps the tint, leaving it clears it
  let e = drag('dragover', bubble);
  assert.ok(e.defaultPrevented);
  assert.strictEqual(e.dataTransfer.dropEffect, 'copy');
  assert.ok(tinted());
  drag('dragleave', bubble, el.input);
  assert.ok(tinted(), 'still over the area');
  drag('dragleave', el.input, document.getElementById('docTitle'));
  assert.ok(!tinted(), 'left the area');
  drag('dragover', el.splitter);
  drag('dragleave', el.splitter, null); // out of the window
  assert.ok(!tinted());
  // a text drag is left to the browser
  e = drag('dragover', bubble, null, ['text/plain']);
  assert.ok(!e.defaultPrevented);
  assert.ok(!tinted());
  drag('dragover', bubble);
  e = drop(bubble, [new window.File(['a\n'], 'a.txt', { type: 'text/plain' })]);
  assert.ok(e.defaultPrevented);
  assert.ok(!tinted(), 'the drop clears the tint');
  T.renderEmpty();
  drop(el.chat.querySelector('.empty'), [new window.File(['b\n'], 'b.md')]);
  drop(el.splitter, [new window.File(['c\n'], 'c.json', { type: 'application/json' })]);
  deq2(chipTexts().map((c) => c[0]), ['a.txt', 'b.md', 'c.json']);
  await waitFor(() => chipTexts().every((c) => c[1] !== 'reading…'), 'the files read');
  // the same refusals as on the composer
  drop(el.chat, [new window.File(['x'], 'shot.png', { type: 'image/png' })]);
  deq2(errors(), ['shot.png cannot be attached. Attach text, Markdown, .docx or .pdf files.']);
  deq2(chipTexts().length, 3);
  clearChips();
  deq2(chipTexts(), []);
});

test('a drop over a layer (Settings, Files, a menu, the header) attaches nothing and keeps the panel page; no tint there', () => {
  const layers = [document.querySelector('#settings h2'), document.getElementById('filesList'), document.getElementById('modelMenu'),
    document.getElementById('chatMenu'), document.getElementById('docTitle')];
  const before = errors().length;
  for (const node of layers) {
    drag('dragover', el.chat);
    assert.ok(tinted());
    const over = drag('dragover', node);
    assert.ok(over.defaultPrevented, node.id || node.tagName);
    assert.strictEqual(over.dataTransfer.dropEffect, 'none', 'no copy offered there');
    assert.ok(!tinted(), `no tint over ${node.id || node.tagName}`);
    const e = drop(node, [new window.File(['x\n'], 'x.md')]);
    assert.ok(e.defaultPrevented, 'the file does not replace the page');
  }
  deq2(chipTexts(), []);
  assert.strictEqual(errors().length, before);
  assert.strictEqual(state.docFiles.length, 1, 'nothing added to the Files list either');
});

test('files pasted into the input attach like a drop; text is pasted as usual; a pasted image alone is refused', async () => {
  // a file copied in a file manager (its path as text beside it on some systems)
  let e = paste(el.input, [new window.File(['# R\n'], 'report.md')], ['text/plain', 'Files']);
  assert.ok(e.defaultPrevented, 'the path is not pasted');
  deq2(chipTexts().map((c) => c[0]), ['report.md']);
  // plain text, and cells copied from a spreadsheet (text with a picture of itself): the browser pastes the text
  e = paste(el.input, [], ['text/plain']);
  assert.ok(!e.defaultPrevented);
  e = paste(el.input, [new window.File(['png'], 'image.png', { type: 'image/png' })], ['text/plain', 'text/html', 'Files']);
  assert.ok(!e.defaultPrevented);
  deq2(chipTexts().map((c) => c[0]), ['report.md']);
  // a screenshot: refused with the drop's message, not swallowed
  const before = errors().length;
  e = paste(el.input, [new window.File(['png'], 'image.png', { type: 'image/png' })], ['Files']);
  assert.ok(e.defaultPrevented);
  deq2(errors().slice(before), ['image.png cannot be attached. Attach text, Markdown, .docx or .pdf files.']);
  // an image copied with other files: the others attach, the image is refused
  paste(el.input, [new window.File(['t\n'], 'notes.txt'), new window.File(['png'], 'photo.png', { type: 'image/png' })], ['Files']);
  deq2(chipTexts().map((c) => c[0]), ['report.md', 'notes.txt']);
  deq2(errors().slice(before + 1), ['photo.png cannot be attached. Attach text, Markdown, .docx or .pdf files.']);
  await waitFor(() => chipTexts().every((c) => c[1] !== 'reading…'), 'the files read');
  clearChips();
});

function deq2(a, b) { assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b))); }
