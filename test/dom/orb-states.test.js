'use strict';
// The orb's mode for each state of a live bubble (render.js orbModeFor / syncOrb, jsdom): globe for a search (a
// pending find_in_document, a server-side web search row), rubik for a write (its re-read: orb-verify), orbits for
// other calls, wave while a card waits on the user (ask_user, then back), a Your-turn card's own listening orb, the
// orb at the status line without a Thinking section; and the location line under the live bubble (placeText,
// headingAbove): the text for each tool, the heading lookup in both outline kinds, never a scroll of the document.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { load, click, tick } = require('../lib/dom-sandbox');
const { waitFor } = require('../lib/sandbox');

let env, T, state, el;
const sent = []; // every message the panel sends to the Docs tab
const $$ = (sel) => [...el.chat.querySelectorAll(sel)];

before(async () => {
  env = await load();
  ({ T, state, el } = env);
  const orig = env.chrome.tabs.sendMessage;
  env.chrome.tabs.sendMessage = async (id, msg) => { sent.push(msg && msg.type); return orig ? orig(id, msg) : { ok: true }; };
});
after(() => env.close());

const pending = (name, args = {}) => ({ log: true, name, summary: '', args, result: null, status: 'pending' });
const done = (name, args = {}) => ({ ...pending(name, args), result: 'ok', status: 'ok' });
function bubble() {
  el.chat.textContent = '';
  return T.addAssistantBubble();
}
const orbOf = (b) => b.querySelector('canvas.orb');

test('a running call: globe for a search, rubik for a write, orbits otherwise; a server web search row: globe', () => {
  const b = bubble();
  T.updateAssistantBubble(b, { activity: [pending('find_in_document', { query: 'x' })] });
  assert.strictEqual(orbOf(b).dataset.orb, 'globe');
  for (const name of ['replace_text', 'insert_after_line', 'delete_lines', 'replace_section', 'replace_all', 'format_text', 'replace_selection']) {
    T.updateAssistantBubble(b, { activity: [done('find_in_document'), pending(name, { old_text: 'a' })] });
    assert.strictEqual(orbOf(b).dataset.orb, 'rubik', name);
  }
  for (const name of ['read_lines', 'get_outline', 'remember', 'ask_user', 'find_reference']) {
    T.updateAssistantBubble(b, { activity: [pending(name)] });
    assert.strictEqual(orbOf(b).dataset.orb, 'orbits', name);
  }
  T.updateAssistantBubble(b, { activity: [done('read_lines')] });
  assert.ok(orbOf(b).classList.contains('hidden')); // finished, not streaming
  // streaming: a server-side web search row arrives before any text
  const s = bubble();
  T.updateAssistantBubble(s, { streaming: true });
  assert.strictEqual(orbOf(s).dataset.orb, 'ring');
  T.updateAssistantBubble(s, { streaming: true, activity: [{ name: 'web_search', summary: 'EPR spectra' }] });
  assert.strictEqual(orbOf(s).dataset.orb, 'globe');
  T.updateAssistantBubble(s, { streaming: true, activity: [{ name: 'web_search', summary: 'EPR spectra' }, { name: 'open_page', summary: 'x' }] });
  assert.strictEqual(orbOf(s).dataset.orb, 'orbits');
  T.updateAssistantBubble(s, { streaming: true, text: 'The', activity: [{ name: 'web_search', summary: 'EPR spectra' }] });
  assert.strictEqual(orbOf(s).dataset.orb, 'ribbon');
  // no Thinking section: the orb is at the status line, right before the location line and the buttons
  assert.strictEqual(orbOf(s).parentElement, s);
  assert.ok(orbOf(s).nextElementSibling.classList.contains('agent-place'));
  // reasoning arrives: the orb moves into the summary, in place of the marker
  T.updateAssistantBubble(s, { streaming: true, text: 'The', reasoning: 'Hm.' });
  assert.strictEqual(orbOf(s).parentElement, s.querySelector('.thinking > summary'));
  assert.strictEqual(s.querySelectorAll('canvas.orb').length, 1);
});

test('listening: wave while the ask_user card waits, back to the call\'s own mode once it is answered', async () => {
  const b = bubble();
  T.updateAssistantBubble(b, { activity: [pending('ask_user')] });
  assert.strictEqual(orbOf(b).dataset.orb, 'orbits');
  const s = T.takeSnapshot();
  s.signal = new AbortController().signal;
  const call = { id: 'q1', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ question: 'Which?', options: ['A', 'B'] }) } };
  const p = T.executeTool(call, 'manual', s, {});
  await waitFor(() => orbOf(b).dataset.orb === 'wave', 'the wave');
  click($$('.tool-card.preview.ask button')[0]);
  await p;
  await waitFor(() => orbOf(b).dataset.orb === 'orbits', 'back to orbits');
});

test('a Your-turn card of the self-test gets a listening orb of its own', async () => {
  el.chat.textContent = '';
  T.renderHistory(); // watches the chat
  const ac = new AbortController();
  const p = T.confirmYourTurn('Select the word "fox".', ac.signal);
  await waitFor(() => $$('.tool-card.your-turn canvas.orb').length === 1, 'the card orb');
  const orb = $$('.tool-card.your-turn canvas.orb')[0];
  assert.strictEqual(orb.dataset.orb, 'wave');
  assert.strictEqual(orb.getAttribute('aria-hidden'), 'true');
  assert.strictEqual(orb.parentElement, $$('.tool-card.your-turn .pv-head')[0]);
  ac.abort();
  assert.strictEqual(await p, 'stop');
});

const MD = '# Title\n\nIntro line.\n\n## Methods\n\nWe measured the spectra.\n\nMore text.\n\n## Results\n\nThe peak is at 3.5 mT.';

test('the location line: the text for each tool with the nearest heading above (Markdown export)', () => {
  Object.assign(state, { docText: MD, docFormat: 'markdown', docModel: null });
  const cases = [
    [pending('insert_after_line', { line: 7, text: 'x' }), 'Writing in Methods, after line 7'],
    [pending('insert_after_line', { line: 0, text: 'x' }), 'Writing at the beginning'],
    [pending('insert_after_line', { line: 3, text: 'x' }), 'Writing in Title, after line 3'],
    [pending('delete_lines', { start: 9, end: 10 }), 'Deleting in Methods, lines 9–10'],
    [pending('delete_lines', { start: 13, end: 13 }), 'Deleting in Results, line 13'],
    [pending('format_lines', { start: 7, end: 9, bold: true }), 'Formatting in Methods, lines 7–9'],
    [pending('read_lines', { start: 12, end: 13 }), 'Reading lines 12–13 in Results'],
    [pending('read_lines', { start: 1, end: 5, doc: 'https://docs.google.com/document/d/OTHER/edit' }), 'Reading lines 1–5 of another document'],
    [pending('replace_text', { old_text: 'The peak is', new_text: 'The peak was' }), 'Writing in Results, line 13'],
    [pending('replace_text', { old_text: 'not in the document', new_text: 'x' }), ''],
    [pending('format_text', { old_text: 'We measured', bold: true }), 'Formatting in Methods, line 7'],
    [pending('replace_section', { heading: 'Methods', new_text: 'x' }), 'Writing in Methods'],
    [pending('replace_all', { old_text: 'spectra', new_text: 'spectrum' }), 'Replacing every "spectra"'],
    [pending('find_in_document', { query: 'peak' }), 'Searching the document for "peak"'],
    [pending('get_outline', {}), 'Reading the outline'],
    [pending('ask_user', { question: 'q' }), ''],
  ];
  for (const [a, want] of cases) assert.strictEqual(T.placeText(a), want, a.name + ' ' + JSON.stringify(a.args));
  assert.strictEqual(T.headingAbove(4), 'Title');
  assert.strictEqual(T.headingAbove(5), 'Methods');
  assert.strictEqual(T.headingAbove(100), 'Results');
});

test('the location line with the Docs API outline (heading styles), and a plain-text export without one', () => {
  const lines = [
    { line: 1, text: 'Intro', heading: 0 }, { line: 2, text: 'Methods', heading: 2, style: 'HEADING_2' },
    { line: 3, text: 'Body text here', heading: 0 }, { line: 4, text: '', heading: 2, style: 'HEADING_2' },
  ];
  Object.assign(state, { docText: 'Intro\nMethods\nBody text here\n', docFormat: 'docs-api', docModel: { lines } });
  assert.strictEqual(T.placeText(pending('insert_after_line', { line: 3 })), 'Writing in Methods, after line 3');
  assert.strictEqual(T.placeText(pending('replace_text', { old_text: 'Body text' })), 'Writing in Methods, line 3');
  assert.strictEqual(T.placeText(pending('delete_lines', { start: 1, end: 1 })), 'Deleting line 1'); // no heading above
  Object.assign(state, { docText: 'One\nTwo', docFormat: 'text', docModel: null });
  assert.strictEqual(T.placeText(pending('read_lines', { start: 1, end: 2 })), 'Reading lines 1–2');
});

test('under the live bubble while the call runs, gone when it ends; plain text, never a scroll of the Docs tab', async () => {
  Object.assign(state, { docText: MD, docFormat: 'markdown', docModel: null });
  sent.length = 0;
  const b = bubble();
  const place = b.querySelector('.agent-place');
  assert.ok(place.classList.contains('hidden'));
  T.updateAssistantBubble(b, { activity: [done('read_lines', { start: 1, end: 3 }), pending('insert_after_line', { line: 7, text: 'x' })] });
  assert.strictEqual(place.textContent, 'Writing in Methods, after line 7');
  assert.ok(!place.classList.contains('hidden'));
  assert.strictEqual(place.querySelector('a, button'), null);
  click(place);
  await tick(5);
  T.updateAssistantBubble(b, { activity: [done('read_lines', { start: 1, end: 3 }), done('insert_after_line', { line: 7, text: 'x' })] });
  assert.strictEqual(place.textContent, '');
  assert.ok(place.classList.contains('hidden'));
  assert.deepStrictEqual(sent.filter((t) => !['PING', 'GET_SELECTION', 'ATTENTION'].includes(t)), []);
});
