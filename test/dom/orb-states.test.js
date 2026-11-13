'use strict';
// The bubble's footer status and its orb for each state (render.js bubbleStatus / syncOrb, jsdom): globe for a search (a
// pending find_in_document, a server-side web search row), rubik for a write (its re-read: orb-verify), orbits for
// other calls, wave while a card waits on the user (ask_user, then back), a Your-turn card's own listening orb, the
// state table of the live bubble; and the location of a running call (placeText, headingAbove): the text for each
// tool, the heading lookup in both outline kinds, never a scroll of the document.
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
// A live bubble (liveAnswer's ensureBubble marks it live), or one from the history (live false).
function bubble(live = true) {
  el.chat.textContent = '';
  const b = T.addAssistantBubble();
  b._live = live;
  return b;
}
const orbOf = (b) => b.querySelector('canvas.orb');
const statusOf = (b) => (b.querySelector('.thinking').classList.contains('hidden') ? '' : b.querySelector('.thinking-label').textContent);
const modeOf = (b) => { const o = orbOf(b); return o && !o.classList.contains('hidden') ? o.dataset.orb : null; };

test('a running call: globe for a search, rubik for a write, orbits otherwise; a server web search row: globe', () => {
  const b = bubble();
  T.updateAssistantBubble(b, { activity: [pending('find_in_document', { query: 'x' })] });
  assert.strictEqual(modeOf(b), 'globe');
  for (const name of ['replace_text', 'insert_after_line', 'delete_lines', 'replace_section', 'replace_all', 'format_text', 'replace_selection']) {
    T.updateAssistantBubble(b, { activity: [done('find_in_document'), pending(name, { old_text: 'a' })] });
    assert.strictEqual(modeOf(b), 'rubik', name);
  }
  for (const name of ['read_lines', 'get_outline', 'remember', 'ask_user', 'find_reference']) {
    T.updateAssistantBubble(b, { activity: [pending(name)] });
    assert.strictEqual(modeOf(b), 'orbits', name);
  }
  // the call ended, the turn goes on: "Working…" with the ring
  T.updateAssistantBubble(b, { activity: [done('read_lines')] });
  assert.strictEqual(modeOf(b), 'ring');
  assert.strictEqual(statusOf(b), 'Working…');
  // streaming: a server-side web search row arrives before any text
  const s = bubble();
  T.updateAssistantBubble(s, { streaming: true });
  assert.strictEqual(modeOf(s), 'ring');
  const web = { name: 'web_search', summary: 'EPR spectra' };
  T.updateAssistantBubble(s, { streaming: true, last: 'activity', activity: [web] });
  assert.strictEqual(modeOf(s), 'globe');
  assert.strictEqual(statusOf(s), 'Searching…');
  T.updateAssistantBubble(s, { streaming: true, last: 'activity', activity: [web, { name: 'open_page', summary: 'x' }] });
  assert.strictEqual(modeOf(s), 'orbits');
  assert.strictEqual(statusOf(s), 'Working…'); // open_page has no kind word
  // the orb stays in the summary, before the label: never moved
  assert.strictEqual(orbOf(s).parentElement, s.querySelector('.thinking > summary'));
  assert.strictEqual(orbOf(s).nextElementSibling, s.querySelector('.thinking-label'));
  // answer text: "Waiting…" with the ring and the typing cursor; a call that runs meanwhile brings its own mode
  T.updateAssistantBubble(s, { streaming: true, last: 'text', text: 'The', activity: [web] });
  assert.strictEqual(modeOf(s), 'ring');
  assert.strictEqual(statusOf(s), 'Waiting…');
  assert.ok(s.classList.contains('typing'));
  T.updateAssistantBubble(s, { streaming: true, last: 'text', text: 'The', activity: [pending('find_in_document', { query: 'x' })] });
  assert.strictEqual(modeOf(s), 'globe');
  assert.ok(!s.classList.contains('typing'));
  assert.strictEqual(s.querySelectorAll('canvas.orb').length, 1);
});

test('the location of a running call is the status line; plain text, never a scroll of the Docs tab', async () => {
  Object.assign(state, { docText: MD, docFormat: 'markdown', docModel: null });
  sent.length = 0;
  const b = bubble();
  T.updateAssistantBubble(b, { activity: [done('read_lines', { start: 1, end: 3 }), pending('insert_after_line', { line: 7, text: 'x' })] });
  assert.strictEqual(statusOf(b), 'Writing in Methods, after line 7');
  const label = b.querySelector('.thinking-label');
  assert.strictEqual(label.querySelector('a, button'), null);
  click(label);
  await tick(5);
  T.updateAssistantBubble(b, { activity: [done('read_lines', { start: 1, end: 3 }), done('insert_after_line', { line: 7, text: 'x' })] });
  assert.strictEqual(statusOf(b), 'Working…');
  assert.deepStrictEqual(sent.filter((t) => !['PING', 'GET_SELECTION', 'ATTENTION'].includes(t)), []);
});

test('listening: wave while the ask_user card waits, back to the call\'s own mode once it is answered', async () => {
  const b = bubble();
  T.updateAssistantBubble(b, { activity: [pending('ask_user')] });
  assert.strictEqual(modeOf(b), 'orbits');
  const s = T.takeSnapshot();
  s.signal = new AbortController().signal;
  const call = { id: 'q1', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ question: 'Which?', options: ['A', 'B'] }) } };
  const p = T.executeTool(call, 'manual', s, {});
  await waitFor(() => modeOf(b) === 'wave', 'the wave');
  assert.strictEqual(statusOf(b), 'Asking…'); // the waiting call's line
  click($$('.tool-card.preview.ask button')[0]);
  await p;
  await waitFor(() => modeOf(b) === 'orbits', 'back to orbits');
});

test('a Your-turn card of the self-test gets a listening orb of its own', async () => {
  el.chat.textContent = '';
  const ac = new AbortController();
  const p = T.confirmYourTurn('Select the word "fox".', ac.signal);
  assert.strictEqual($$('.tool-card.your-turn canvas.orb').length, 1);
  const orb = $$('.tool-card.your-turn canvas.orb')[0];
  assert.strictEqual(orb.dataset.orb, 'wave');
  assert.strictEqual(orb.getAttribute('aria-hidden'), 'true');
  assert.strictEqual(orb.parentElement, $$('.tool-card.your-turn .pv-head')[0]);
  ac.abort();
  assert.strictEqual(await p, 'stop');
});

const MD = '# Title\n\nIntro line.\n\n## Methods\n\nWe measured the spectra.\n\nMore text.\n\n## Results\n\nThe peak is at 3.5 mT.';

test('the location: the text for each tool with the nearest heading above (Markdown export)', () => {
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
    [pending('replace_text', { old_text: 'not in the document', new_text: 'x' }), 'Editing the document…'], // no location: the pending text
    [pending('edit_document', {}), 'Editing the document…'],
    [pending('undo_last_edit', {}), 'Undoing the last edit…'],
    [pending('replace_selection', { text: 'x' }), 'Replacing the selection…'],
    [{ ...pending('edit_document', {}), progress: 'Revising Methods: paragraph 2 of 5' }, 'Revising Methods: paragraph 2 of 5'],
    [pending('format_text', { old_text: 'We measured', bold: true }), 'Formatting in Methods, line 7'],
    [pending('format_text', { old_text: 'peak', line: 7, bold: true }), 'Formatting in Methods, line 7'], // line wins over the text's line
    [pending('format_text', { old_text: 'peak', all: true, bold: true }), 'Formatting every "peak"'],
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

test('the location with the Docs API outline (heading styles), and a plain-text export without one', () => {
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

// The bubble's footer, its status at the left, one rule set (render.js bubbleStatus, evaluated top-down, the first match
// wins). The orb stands in the summary in place of its marker while the turn runs; once the turn has ended the status is
// past tense and the reasoning opens below the footer's row (▸). The token line (meta) is at the footer's right, only
// once the turn has ended; the footer shows while the turn runs and, once ended, while it has the status or the tokens.
//
// | state                                                  | status text                         | orb             | ▸  | pulse | cursor | meta |
// |--------------------------------------------------------|-------------------------------------|-----------------|----|-------|--------|------|
// | live: a card waits on the user                         | the waiting call's line*            | wave            | no | no    | no     | no   |
// | live: a call of this panel runs (newest pending entry) | its location, progress or kind word*| toolOrbMode     | no | no    | no     | no   |
// | live: the stream writes a call (its name arrived)      | its kind word**                     | ring            | no | no    | no     | no   |
// | live: a server-side row came last                      | its kind word** ("Searching…")      | toolOrbMode     | no | no    | no     | no   |
// | live: the reasoning streams                            | Thinking…                           | ring            | no | yes   | no     | no   |
// | live: the answer text streams                          | Waiting…                            | ring            | no | no    | yes    | no   |
// | live: anything else (sent, between rounds and calls)   | Working…                            | ring            | no | no    | no     | no   |
// | ended, stopped                                         | Stopped after Ns                    | none                             | if reasoning | no | no | yes |
// | ended, tool calls                                      | Worked for Ns                       | none            | if reasoning | no | no | yes |
// | ended, reasoning with its time                         | Thought for Ns                      | none            | yes| no    | no     | yes  |
// | ended, reasoning stored without its time               | Thinking                            | none            | yes| no    | no     | yes  |
// | ended, none of these                                   | (the status is hidden)              | none            | –  | –     | –      | yes  |
// The footer: shown in every row above; with the status hidden and no usage it is hidden too (a plain reply without
// tokens).
// * placeText, else writeProgressText, else kindText. ** render.js KIND_WORDS: Reading…, Editing…, Searching…, Asking…,
// Delegating…, Checking…, else Working…; remember: "Updating DOC.md…" / "Updating MAIN.md…" (its file).
// The meta line shows only once the turn has ended (when there is usage to show).
const look = (b) => {
  const think = b.querySelector('.thinking');
  const foot = b.querySelector('.msg-foot');
  // the footer is the last line; its row: the status at its left, the token line at its right; then the reasoning
  assert.strictEqual(b.lastElementChild, foot);
  assert.deepStrictEqual([...foot.children].map((c) => c.className.split(' ')[0]), ['thinking', 'msg-meta', 'thinking-body']);
  return { text: statusOf(b), orb: modeOf(b), marker: !think.classList.contains('hidden') && !think.classList.contains('live') && !think.classList.contains('no-body'),
    pulse: think.classList.contains('pulse'), cursor: b.classList.contains('typing'), meta: !b.querySelector('.msg-meta').classList.contains('hidden'),
    foot: !foot.classList.contains('hidden') };
};
const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

test('the state table: status text, orb, marker, pulse, cursor and meta for each state of a turn', () => {
  Object.assign(state, { docText: '# T\n\nx', docFormat: 'markdown', docModel: null });
  const b = bubble();
  const r1 = { reasoning: 'Outline first.', usage };
  const live = (text, orb, more = {}) => ({ text, orb, marker: false, pulse: false, cursor: false, meta: false, foot: true, ...more });
  const steps = [
    [{ streaming: true }, live('Working…', 'ring')],
    [{ streaming: true, last: 'reasoning', ...r1 }, live('Thinking…', 'ring', { pulse: true })],
    // the stream delivered the call's name, its arguments still stream: the kind word
    [{ streaming: true, last: 'call', ...r1, thoughtMs: 2000, calling: 'get_outline' }, live('Reading…', 'ring')],
    // the stream ended, the call's row is not there yet
    [{ ...r1, thoughtMs: 2000 }, live('Working…', 'ring')],
    // the call runs: its location
    [{ ...r1, thoughtMs: 2000, activity: [pending('get_outline')] }, live('Reading the outline', 'orbits')],
    // a call without a location in the document: its file (remember) or its kind word (ask_user)
    [{ ...r1, thoughtMs: 2000, activity: [done('get_outline'), pending('remember')] }, live('Updating DOC.md…', 'orbits')],
    [{ ...r1, thoughtMs: 2000, activity: [done('get_outline'), pending('remember', { scope: 'main' })] }, live('Updating MAIN.md…', 'orbits')],
    [{ ...r1, thoughtMs: 2000, activity: [done('get_outline'), pending('ask_user')] }, live('Asking…', 'orbits')],
    // between calls and rounds
    [{ ...r1, thoughtMs: 2000, activity: [done('get_outline'), done('remember')] }, live('Working…', 'ring')],
  ];
  for (const [upd, want] of steps) {
    T.updateAssistantBubble(b, upd);
    assert.deepStrictEqual(look(b), want, JSON.stringify(upd));
  }
  // the next round awaited: "Working…" with the ring, not the mode of round 1's last call
  T.startAssistantRound(b);
  T.updateAssistantBubble(b, { streaming: true });
  assert.deepStrictEqual(look(b), live('Working…', 'ring'));
  T.updateAssistantBubble(b, { streaming: true, last: 'reasoning', reasoning: 'Now answer.' });
  assert.deepStrictEqual(look(b), live('Thinking…', 'ring', { pulse: true }));
  // the answer text: "Waiting…", the orb stays, the cursor shows
  T.updateAssistantBubble(b, { streaming: true, last: 'text', reasoning: 'Now answer.', thoughtMs: 1000, text: 'Done.' });
  assert.deepStrictEqual(look(b), live('Waiting…', 'ring', { cursor: true }));
  // the stream ended, the turn still runs: no meta, no past tense
  T.updateAssistantBubble(b, { reasoning: 'Now answer.', thoughtMs: 1000, text: 'Done.', usage });
  assert.deepStrictEqual(look(b), live('Working…', 'ring'));
  // the end: "Worked for Ns" (tool calls), the marker (reasoning to open), the meta line
  T.endAssistantBubble(b, { workedMs: 9000 });
  assert.deepStrictEqual(look(b), { text: 'Worked for 9s', orb: null, marker: true, pulse: false, cursor: false, meta: true, foot: true });
  const h = bubble(false);
  T.updateAssistantBubble(h, { reasoning: 'Hm.', thoughtMs: 1000, text: 'Done.', workedMs: 9000, stopped: true, usage });
  assert.deepStrictEqual(look(h), { text: 'Stopped after 9s', orb: null, marker: true, pulse: false, cursor: false, meta: true, foot: true });
  // a turn with tool calls but no reasoning: the label alone, nothing to open
  T.updateAssistantBubble(h, { text: 'Done.', workedMs: 4000, activity: [done('get_outline')], usage });
  assert.deepStrictEqual(look(h), { text: 'Worked for 4s', orb: null, marker: false, pulse: false, cursor: false, meta: true, foot: true });
  // a turn without tools ends on "Thought for Ns"; reasoning stored without its time: "Thinking"; nothing: no status
  T.updateAssistantBubble(h, { reasoning: 'Hm.', thoughtMs: 4000, text: 'Yes.', usage });
  assert.deepStrictEqual(look(h), { text: 'Thought for 4s', orb: null, marker: true, pulse: false, cursor: false, meta: true, foot: true });
  T.updateAssistantBubble(h, { reasoning: 'Hm.', text: 'Yes.', usage });
  assert.strictEqual(statusOf(h), 'Thinking');
  // a plain reply: the footer holds the tokens alone (the left side empty); without usage there is no footer
  T.updateAssistantBubble(h, { text: 'Yes.', usage });
  assert.deepStrictEqual(look(h), { text: '', orb: null, marker: false, pulse: false, cursor: false, meta: true, foot: true });
  T.updateAssistantBubble(h, { text: 'Yes.' });
  assert.deepStrictEqual(look(h), { text: '', orb: null, marker: false, pulse: false, cursor: false, meta: false, foot: false });
  assert.strictEqual(orbOf(h), null, 'a bubble from the history never gets an orb');
  // a server-side row (web search, a Munin persona tool) that came last: its kind word with its mode; the reasoning
  // that follows takes over
  const w = bubble();
  const row = { name: 'web_search', summary: 'EPR' };
  T.updateAssistantBubble(w, { streaming: true, last: 'activity', reasoning: 'Look it up.', activity: [row] });
  assert.deepStrictEqual(look(w), live('Searching…', 'globe'));
  T.updateAssistantBubble(w, { streaming: true, last: 'reasoning', reasoning: 'Look it up. Found.', activity: [row] });
  assert.deepStrictEqual(look(w), live('Thinking…', 'ring', { pulse: true }));
});

test('opening the reasoning: the body shows below the footer\'s row, the token line stays on the row beside the label', async () => {
  const b = bubble(false);
  T.updateAssistantBubble(b, { reasoning: 'Plan it.', thoughtMs: 2000, text: 'Done.', usage });
  const foot = b.querySelector(':scope > .msg-foot');
  const think = foot.querySelector(':scope > .thinking');
  const meta = foot.querySelector(':scope > .msg-meta');
  const body = foot.querySelector(':scope > .thinking-body');
  // the body is the footer's own child after the token line, never inside the details that shares the row
  assert.ok(body && !think.contains(body));
  assert.deepStrictEqual([...foot.children], [think, meta, body]);
  assert.strictEqual(think.querySelectorAll(':scope > *').length, 1, 'the details holds only its summary');
  assert.ok(body.classList.contains('hidden'), 'closed: no reasoning');
  think.open = true;
  await waitFor(() => !body.classList.contains('hidden'), 'the toggle shows the body');
  assert.strictEqual(body.textContent, 'Plan it.');
  assert.ok(!meta.classList.contains('hidden'));
  assert.ok(meta.compareDocumentPosition(body) & 4, 'the token line precedes the body'); // DOCUMENT_POSITION_FOLLOWING
  assert.strictEqual(meta.parentElement, foot);
  // a repaint keeps it open; closing hides it again
  T.updateAssistantBubble(b, { reasoning: 'Plan it.', thoughtMs: 2000, text: 'Done.', usage });
  assert.ok(!body.classList.contains('hidden'));
  think.open = false;
  await waitFor(() => body.classList.contains('hidden'), 'the toggle hides the body');
  // an open details with nothing to open (a reply without reasoning) shows no body
  think.open = true;
  await waitFor(() => !body.classList.contains('hidden'), 'open again');
  T.updateAssistantBubble(b, { text: 'Done.', workedMs: 4000, activity: [done('get_outline')], usage });
  assert.ok(think.classList.contains('no-body'));
  assert.ok(body.classList.contains('hidden'), 'no-body hides the body');
});

test('the footer never hides and stays the last line while the turn runs; the orb is made once, in the summary', () => {
  const b = bubble();
  const summary = b.querySelector('.thinking > summary');
  const updates = [{ streaming: true }, { streaming: true, last: 'reasoning', reasoning: 'a' }, { streaming: true, last: 'text', reasoning: 'a', text: 'b' },
    { reasoning: 'a', text: 'b', activity: [pending('get_outline')] }, { reasoning: 'a', text: 'b', activity: [done('get_outline')] }];
  for (const u of updates) {
    T.updateAssistantBubble(b, u);
    assert.ok(statusOf(b), JSON.stringify(u));
    assert.strictEqual(b.lastElementChild, b.querySelector('.msg-foot'));
    assert.strictEqual(b.querySelector('.msg-foot').firstElementChild, b.querySelector('.thinking'));
    assert.ok(!b.querySelector('.msg-foot').classList.contains('hidden'));
    assert.strictEqual(summary.firstElementChild, orbOf(b));
    assert.ok(b.querySelector('.thinking').classList.contains('live'));
  }
  assert.strictEqual(b.querySelectorAll('canvas.orb').length, 1);
});

test('the frozen frame after an error stays in the status line of the turn\'s last bubble, dimmed; with no status line, in the error row; Stop leaves none', () => {
  const wasBusy = state.busy;
  state.busy = true; // freezeTurnOrb draws only inside a turn
  try {
    const a = bubble();
    T.updateAssistantBubble(a, { streaming: true, last: 'activity', reasoning: 'Hm.', thoughtMs: 1000, activity: [{ name: 'web_search', summary: 'EPR' }] });
    T.endAssistantBubble(a, { workedMs: 3000 }); // an error ended the turn: its bubble ends, then the error row
    T.freezeTurnOrb(null);
    assert.strictEqual(orbOf(a).parentElement, a.querySelector('.thinking > summary'));
    assert.strictEqual(orbOf(a).dataset.orbFrozen, 'true');
    assert.strictEqual(orbOf(a).dataset.orb, 'globe');
    assert.strictEqual(statusOf(a), 'Worked for 3s');
    T.updateAssistantBubble(a, { reasoning: 'Hm.', thoughtMs: 1000, workedMs: 3000 }); // a repaint keeps it
    assert.strictEqual(orbOf(a).dataset.orbFrozen, 'true');
    // the turn's last bubble has no status line (no reasoning, no tools): the frame goes into the error row
    const n = bubble();
    T.updateAssistantBubble(n, { streaming: true });
    T.endAssistantBubble(n);
    const row = T.addError('Something failed.'); // addError freezes it
    assert.strictEqual(row.querySelector('canvas.orb').dataset.orb, 'ring');
    assert.strictEqual(row.querySelector('canvas.orb').dataset.orbFrozen, 'true');
    // Stop keeps no frame: the label and its arrow only
    const s = bubble();
    T.updateAssistantBubble(s, { streaming: true, last: 'reasoning', reasoning: 'Hm.' });
    T.endAssistantBubble(s, { workedMs: 2000, stopped: true });
    T.dropTurnOrb(); // the turn ended stopped (runTurn, reportTurnError)
    const after = T.addError('Later.');
    assert.strictEqual(after.querySelector('canvas.orb'), null);
    assert.strictEqual(statusOf(s), 'Stopped after 2s');
    assert.ok(!orbOf(s) || orbOf(s).classList.contains('hidden'));
  } finally {
    state.busy = wasBusy;
  }
});
