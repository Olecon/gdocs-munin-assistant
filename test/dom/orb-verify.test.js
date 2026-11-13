'use strict';
// The verifying phase of a write on the live bubble (render.js bubbleStatus, placeText; jsdom): a pending write shows the
// rubik before and while its batch is sent and the ring while the re-read verifies it; the status line reads
// "Verifying the edit in <heading>" then, and once the call has finished the line reads "Working…" again.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { load } = require('../lib/dom-sandbox');

let env, T, state, el;
before(async () => {
  env = await load();
  ({ T, state, el } = env);
});
after(() => env.close());

const pending = (name, args = {}, phase) => ({ log: true, name, summary: '', args, result: null, status: 'pending', ...(phase ? { phase } : {}) });
const done = (name, args = {}) => ({ log: true, name, summary: '', args, result: 'ok', status: 'ok' });
function bubble() {
  el.chat.textContent = '';
  const b = T.addAssistantBubble();
  b._live = true; // liveAnswer's ensureBubble
  return b;
}
const orbOf = (b) => b.querySelector('canvas.orb');
const MD = '# Title\n\nIntro line.\n\n## Methods\n\nWe measured the spectra.\n\nMore text.\n\n## Results\n\nThe peak is at 3.5 mT.';

test('the orb per phase: rubik for the plan and the batch, ring for the verifying re-read, the ring of "Working…" when done', () => {
  const b = bubble();
  const args = { line: 7, text: 'x' };
  T.updateAssistantBubble(b, { activity: [pending('insert_after_line', args)] });
  assert.strictEqual(orbOf(b).dataset.orb, 'rubik');
  T.updateAssistantBubble(b, { activity: [pending('insert_after_line', args, 'writing')] });
  assert.strictEqual(orbOf(b).dataset.orb, 'rubik');
  T.updateAssistantBubble(b, { activity: [pending('insert_after_line', args, 'verifying')] });
  assert.strictEqual(orbOf(b).dataset.orb, 'ring');
  // the next batch of a multi-step edit writes again
  T.updateAssistantBubble(b, { activity: [pending('insert_after_line', args, 'writing')] });
  assert.strictEqual(orbOf(b).dataset.orb, 'rubik');
  T.updateAssistantBubble(b, { activity: [done('insert_after_line', args)] });
  assert.strictEqual(orbOf(b).dataset.orb, 'ring');
  // a registered writing tool and replace_selection follow the phase too
  for (const name of ['page_parts', 'replace_selection']) {
    T.updateAssistantBubble(b, { activity: [pending(name, { text: 'x' }, 'verifying')] });
    assert.strictEqual(orbOf(b).dataset.orb, 'ring', name);
  }
});

test('the location while the re-read verifies: "Verifying the edit" with the heading of the write', () => {
  Object.assign(state, { docText: MD, docFormat: 'markdown', docModel: null });
  const v = (name, args) => pending(name, args, 'verifying');
  const cases = [
    [v('insert_after_line', { line: 7, text: 'x' }), 'Verifying the edit in Methods'],
    [v('insert_after_line', { line: 0, text: 'x' }), 'Verifying the edit'],
    [v('delete_lines', { start: 13, end: 13 }), 'Verifying the edit in Results'],
    [v('format_lines', { start: 7, end: 9, bold: true }), 'Verifying the edit in Methods'],
    [v('replace_text', { old_text: 'The peak is', new_text: 'x' }), 'Verifying the edit in Results'],
    [v('format_text', { old_text: 'We measured', bold: true }), 'Verifying the edit in Methods'],
    [v('replace_section', { heading: 'Methods', new_text: 'x' }), 'Verifying the edit in Methods'],
    [v('replace_all', { old_text: 'spectra', new_text: 'spectrum' }), 'Verifying the edit'],
    [v('replace_text', { old_text: 'The peak is', new_text: 'x', doc: 'https://docs.google.com/document/d/OTHER/edit' }), 'Verifying the edit'],
    [v('page_parts', { action: 'set_text', part: 'header', text: 'x' }), 'Verifying the edit'],
    // the writing phase keeps the writing text
    [pending('insert_after_line', { line: 7, text: 'x' }, 'writing'), 'Writing in Methods, after line 7'],
  ];
  for (const [a, want] of cases) assert.strictEqual(T.placeText(a), want, a.name + ' ' + JSON.stringify(a.args));
});

test('the live bubble\'s status line follows the phase and reads "Working…" when the call ends', () => {
  Object.assign(state, { docText: MD, docFormat: 'markdown', docModel: null });
  const b = bubble();
  const place = b.querySelector('.thinking-label');
  const args = { start: 7, end: 9, bold: true };
  T.updateAssistantBubble(b, { activity: [pending('format_lines', args, 'writing')] });
  assert.strictEqual(place.textContent, 'Formatting in Methods, lines 7–9');
  T.updateAssistantBubble(b, { activity: [pending('format_lines', args, 'verifying')] });
  assert.strictEqual(place.textContent, 'Verifying the edit in Methods');
  assert.ok(!b.querySelector('.thinking').classList.contains('hidden'));
  T.updateAssistantBubble(b, { activity: [done('format_lines', args)] });
  assert.strictEqual(place.textContent, 'Working…');
});
