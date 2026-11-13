'use strict';
// The thinking orb in the live answer bubble (render.js + orb.js) on a real DOM: one decorative canvas per bubble, in
// its status line in place of the marker, never moved; its mode following the turn ("Working…" with the waiting ring,
// ring while reasoning, ring with "Waiting…" while the answer text streams, globe for a search, rubik for a write,
// orbits for other calls, wave while a card waits on the user), gone after the turn ends, a frozen frame after Stop and
// an error; bubbles rendered from the history get none. jsdom has no 2D context, so only the data-orb attributes and the
// hidden class are visible here (the loop: test/orb.test.js).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { load, click, key, typeInto, tick } = require('../lib/dom-sandbox');
const { installDocTab, waitFor } = require('../lib/sandbox');
const { ev, sseResponse, tu, stopTool, textRound } = require('../lib/streams');
const { liveStream } = require('../lib/live-stream');

let env, T, state, el;
const $$ = (sel) => [...el.chat.querySelectorAll(sel)];
let calls = []; // [canvas, mode] of every orbSetState call render.js makes

before(async () => {
  env = await load();
  ({ T, state, el } = env);
  installDocTab(env);
  env.chrome.tabs.sendMessage = async (id, msg) => {
    switch (msg.type) {
      case 'PING': return { ok: true, title: 'My Doc' };
      case 'GET_SELECTION': return { ok: true, text: '' };
      case 'GET_DOC_TEXT': return { ok: true, text: '# My Doc\n\nAlpha line.\n\nDelta line.', format: 'markdown', title: 'My Doc' };
      default: return { ok: true };
    }
  };
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic';
  Object.assign(state.settings.providers.anthropic, { apiKey: 'sk-ant-test', model: 'claude-opus-5-5' });
  state.applyMode = 'auto'; T.applyApplyMode('auto');
  const orig = env.ctx.orbSetState;
  env.ctx.orbSetState = (c, mode, opts) => { calls.push([c, mode]); orig(c, mode, opts); };
});
after(() => env.close());

const msgStart = ev('message_start', { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 10 } } });
const block = (index, type) => ev('content_block_start', { type: 'content_block_start', index, content_block: type === 'text' ? { type, text: '' } : { type, thinking: '' } });
const delta = (index, d) => ev('content_block_delta', { type: 'content_block_delta', index, delta: d });
const stop = (index) => ev('content_block_stop', { type: 'content_block_stop', index });
const liveOrb = () => $$('.msg.assistant canvas.orb');

async function send(text) {
  await T.createChat();
  calls = [];
  typeInto(el.input, text);
  key(el.input, 'Enter');
}

test('a turn: ring and "Working…" while waiting, "Thinking…" while reasoning, "Waiting…" while the text streams, globe while find_in_document runs, nothing left afterwards', async () => {
  const stream = liveStream();
  let n = 0;
  env.ctx.fetch = async (url) => {
    if (!String(url).includes('api.anthropic.com')) return { ok: false, status: 404, text: async () => '' }; // the export: paste fallback
    return n++ === 0 ? stream.response : sseResponse(textRound('Delta is on line 5.'));
  };
  await send('Where is Delta?');
  await waitFor(() => stream.reads > 0, 'the request');
  // before the first chunk: the waiting ring in the status line, "Working…"
  await waitFor(() => liveOrb().length === 1 && liveOrb()[0].dataset.orb === 'ring', 'the waiting ring');
  const orb = liveOrb()[0];
  const bubble = orb.closest('.msg');
  const sum = bubble.querySelector('.thinking > summary');
  // in place of the summary's marker; the summary keeps its text and stays a summary (clickable, accessible)
  assert.strictEqual(orb.parentElement, sum);
  assert.strictEqual(sum.firstElementChild, orb);
  assert.strictEqual(sum.textContent, 'Working…');
  assert.strictEqual(orb.getAttribute('aria-hidden'), 'true');
  assert.ok(!bubble.classList.contains('typing'));
  stream.push(msgStart + block(0, 'thinking') + delta(0, { type: 'thinking_delta', thinking: 'Let me look.' }));
  await waitFor(() => sum.textContent === 'Thinking…', 'the reasoning');
  assert.strictEqual(orb.dataset.orb, 'ring');
  assert.ok(bubble.querySelector('.thinking').classList.contains('pulse'));
  stream.push(delta(0, { type: 'thinking_delta', thinking: ' More thought.' }));
  await waitFor(() => bubble.querySelector('.thinking-body').textContent.includes('More'), 'more reasoning');
  stream.push(stop(0) + block(1, 'text') + delta(1, { type: 'text_delta', text: 'Searching ' }));
  // the first paint with text: "Waiting…" with the ring and the typing cursor (the first text chunk is painted at once)
  await waitFor(() => bubble.querySelector('.md').textContent === 'Searching ', 'the first text');
  assert.strictEqual(sum.textContent, 'Waiting…');
  assert.strictEqual(orb.dataset.orb, 'ring');
  assert.ok(!orb.classList.contains('hidden'));
  assert.ok(bubble.classList.contains('typing'));
  stream.push(delta(1, { type: 'text_delta', text: 'now.' }));
  await waitFor(() => bubble.querySelector('.md').textContent === 'Searching now.', 'more text');
  assert.strictEqual(bubble.querySelectorAll('canvas.orb').length, 1); // updated in place, never a second one
  stream.push(stop(1) + tu(2, 'toolu_o1', 'find_in_document', { query: 'Delta', doc: null }) + stopTool);
  stream.end();
  await waitFor(() => !state.busy, 'the end of the turn');
  await tick(10);
  // the turn's one orb: ring (waiting, thinking, the text, between rounds) -> globe (the search runs) -> ring; never moved
  const modes = (c) => calls.filter(([x]) => x === c).map(([, m]) => m);
  assert.deepStrictEqual(modes(orb), ['ring', 'globe', 'ring']);
  assert.strictEqual(orb.parentElement, sum);
  assert.deepStrictEqual(calls.filter(([c]) => c !== orb), [], 'one orb for the whole turn');
  // renderHistory replaced the live bubble: it is off the page (its loop ends), the new ones have no orb
  assert.ok(!orb.isConnected);
  assert.strictEqual($$('canvas.orb').length, 0);
  assert.ok($$('.msg.assistant .md').some((m) => m.textContent === 'Delta is on line 5.'));
  T.renderHistory();
  assert.strictEqual($$('canvas.orb').length, 0);
});

test('Stop: no orb is left; the turn\'s last bubble reads "Stopped after Ns" with its arrow', async () => {
  const stream = liveStream();
  env.ctx.fetch = async (url, init) => {
    init.signal.addEventListener('abort', () => stream.fail(Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' })));
    return stream.response;
  };
  await send('Think about it');
  await waitFor(() => stream.reads > 0, 'the request');
  stream.push(msgStart + block(0, 'thinking') + delta(0, { type: 'thinking_delta', thinking: 'Hmm.' }));
  // the waiting orb (a ring left of the first line before the first chunk) moves into the Thinking summary
  await waitFor(() => liveOrb().length && liveOrb()[0].dataset.orb === 'ring' && liveOrb()[0].parentElement.tagName === 'SUMMARY', 'the ring');
  const orb = liveOrb()[0];
  click(el.action); // Stop
  await waitFor(() => !state.busy, 'the stop');
  await tick(10);
  assert.ok(!orb.isConnected);
  assert.strictEqual($$('canvas.orb').length, 0); // a stopped turn keeps no frozen frame
  const last = $$('.msg.assistant').pop();
  assert.match(last.querySelector('.thinking > summary').textContent, /^Stopped after \d+s$/);
  assert.ok($$('.msg.assistant').every((b) => !b.classList.contains('typing')));
  // the next turn's re-render drops it
  T.renderHistory();
  assert.strictEqual($$('canvas.orb').length, 0);
});

test('an error after answer text: the ring of "Waiting…" stays as the frozen frame, in the error row (the bubble has no status line)', async () => {
  const stream = liveStream();
  env.ctx.fetch = async () => stream.response;
  await send('Write something');
  await waitFor(() => stream.reads > 0, 'the request');
  await waitFor(() => liveOrb().length && liveOrb()[0].dataset.orb === 'ring', 'the waiting ring');
  const orb = liveOrb()[0];
  stream.push(msgStart + block(0, 'text') + delta(0, { type: 'text_delta', text: 'Partial' }));
  await waitFor(() => orb.closest('.msg').querySelector('.thinking-label').textContent === 'Waiting…', 'the text');
  stream.fail(new TypeError('Failed to fetch'));
  await waitFor(() => !state.busy, 'the failure');
  await tick(10);
  assert.ok(!orb.isConnected);
  const left = $$('canvas.orb');
  assert.strictEqual(left.length, 1);
  assert.strictEqual(left[0].closest('.msg'), $$('.msg.error').pop());
  assert.strictEqual(left[0].dataset.orbFrozen, 'true');
  assert.ok($$('.msg.assistant .md').some((m) => m.textContent === 'Partial'));
});

test('an error before any reply: the frozen frame goes into the error row; an error outside a turn gets none', async () => {
  const stream = liveStream();
  env.ctx.fetch = async () => stream.response;
  await send('Hello');
  await waitFor(() => stream.reads > 0, 'the request');
  // an edit call streams (its pending card makes the bubble): no text, no reasoning, so the history keeps no bubble
  stream.push(msgStart + tu(0, 'toolu_e1', 'insert_after_line', { line: 1, text: 'New.' }));
  await waitFor(() => liveOrb().length === 1, 'the orb');
  stream.fail(new TypeError('Failed to fetch'));
  await waitFor(() => !state.busy, 'the failure');
  await tick(10);
  const err = $$('.msg.error').pop();
  const orb = err.querySelector('canvas.orb');
  assert.ok(orb);
  assert.strictEqual(orb.dataset.orbFrozen, 'true');
  assert.strictEqual(orb.dataset.orb, 'ring');
  T.addError('Could not copy: denied'); // not busy: no orb
  assert.strictEqual($$('.msg.error').pop().querySelector('canvas.orb'), null);
  T.addChatRow('Stopped.'); // not busy either; a row never gets one
  assert.strictEqual($$('.msg.chat-row').pop().querySelector('canvas.orb'), null);
});

// The live bubble's states in a multi-round turn (render.js bubbleStatus; the owner's real-Chrome report: after a tool
// round the bubble read "Working…" without the orb while the orb sat at "Thought for Ns" below it): one status line.
const round1 = () => msgStart + block(0, 'thinking') + delta(0, { type: 'thinking_delta', thinking: 'Outline first.' }) + stop(0) +
  tu(1, 'toolu_m1', 'get_outline', {}) + stopTool;
const sumOf = (b) => b.querySelector('.thinking > summary');
const placeShown = (b) => (b.querySelector('.thinking').classList.contains('hidden') ? '' : sumOf(b).textContent);

test('a later round awaited: "Working…" with the orb on the status line; its reasoning, its text; the end leaves "Worked for Ns" and no orb', async () => {
  const stream = liveStream();
  let n = 0;
  env.ctx.fetch = async (url) => {
    if (!String(url).includes('api.anthropic.com')) return { ok: false, status: 404, text: async () => '' };
    return n++ === 0 ? sseResponse(round1()) : stream.response;
  };
  await send('Outline please');
  await waitFor(() => stream.reads > 0, 'the second request');
  await waitFor(() => liveOrb().length === 1 && placeShown(liveOrb()[0].closest('.msg')) === 'Working…', 'Working… in round 2');
  const orb = liveOrb()[0];
  const b = orb.closest('.msg');
  // (a) the orb in the footer's status, the bubble's last line, in place of the marker; the ring, not round 1's call mode
  assert.strictEqual(b.lastElementChild, b.querySelector('.msg-foot'));
  assert.strictEqual(b.querySelector('.msg-foot').firstElementChild, b.querySelector('.thinking'));
  assert.strictEqual(orb.parentElement, sumOf(b));
  assert.ok(b.querySelector('.thinking').classList.contains('live'));
  assert.strictEqual(orb.dataset.orb, 'ring');
  assert.ok(!orb.classList.contains('hidden'));
  // (b) round 2's reasoning streams: the same line reads "Thinking…"
  stream.push(msgStart + block(0, 'thinking') + delta(0, { type: 'thinking_delta', thinking: 'Now answer.' }));
  await waitFor(() => sumOf(b).textContent === 'Thinking…', 'Thinking… in round 2');
  assert.strictEqual(orb.parentElement, sumOf(b));
  // the answer text: "Waiting…" with the orb, the typing cursor too
  stream.push(stop(0) + block(1, 'text') + delta(1, { type: 'text_delta', text: 'Done.' }));
  await waitFor(() => b.querySelector('.md').textContent === 'Done.', 'the text');
  assert.strictEqual(placeShown(b), 'Waiting…');
  assert.ok(!orb.classList.contains('hidden'));
  assert.ok(b.classList.contains('typing'));
  stream.push(stop(1) + ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }) + ev('message_stop', { type: 'message_stop' }));
  stream.end();
  await waitFor(() => !state.busy, 'the end of the turn');
  await tick(10);
  // (c) the end: no orb, "Worked for Ns" (the turn made a tool call), no cursor
  assert.strictEqual($$('canvas.orb').length, 0);
  const last = $$('.msg.assistant').pop();
  assert.match(sumOf(last).textContent, /^Worked for \d+s$/);
  assert.ok(!last.classList.contains('typing'));
});

test('Stop while a later round is awaited: no orb is left, the status line reads "Stopped after Ns"', async () => {
  const stream = liveStream();
  let n = 0;
  env.ctx.fetch = async (url, init) => {
    if (!String(url).includes('api.anthropic.com')) return { ok: false, status: 404, text: async () => '' };
    if (n++ === 0) return sseResponse(round1());
    init.signal.addEventListener('abort', () => stream.fail(Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' })));
    return stream.response;
  };
  await send('Outline again');
  await waitFor(() => stream.reads > 0, 'the second request');
  await waitFor(() => liveOrb().length === 1 && placeShown(liveOrb()[0].closest('.msg')) === 'Working…', 'Working… in round 2');
  click(el.action); // Stop
  await waitFor(() => !state.busy, 'the stop');
  await tick(10);
  // (d) no frozen frame: the label and its arrow only
  assert.strictEqual($$('canvas.orb').length, 0);
  const last = $$('.msg.assistant').pop();
  assert.match(sumOf(last).textContent, /^Stopped after \d+s$/); // the user's Stop, by the "Worked for" clock
  assert.ok(!last.classList.contains('typing'));
  T.renderHistory();
  assert.strictEqual($$('canvas.orb').length, 0);
  assert.match(sumOf($$('.msg.assistant').pop()).textContent, /^Stopped after \d+s$/); // stored: _stopped
});
