'use strict';
// The thinking orb in the live answer bubble (render.js + orb.js) on a real DOM: one decorative canvas per bubble,
// in place of the Thinking section's marker while that section shows (else at the status line), its mode following
// the stream (ring while reasoning, ribbon while text streams, globe for a search, rubik for a write, orbits for
// other calls, wave while a card waits on the user), hidden or gone after the reply ends, a frozen frame after Stop
// and an error; bubbles rendered from the history get none. jsdom has no 2D context, so only the data-orb attributes
// and the hidden class are visible here (the loop: test/orb.test.js).
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

test('a turn: ring while reasoning (in the Thinking summary), ribbon while text streams, globe while find_in_document runs, nothing left afterwards', async () => {
  const stream = liveStream();
  let n = 0;
  env.ctx.fetch = async (url) => {
    if (!String(url).includes('api.anthropic.com')) return { ok: false, status: 404, text: async () => '' }; // the export: paste fallback
    return n++ === 0 ? stream.response : sseResponse(textRound('Delta is on line 5.'));
  };
  await send('Where is Delta?');
  await waitFor(() => stream.reads > 0, 'the request');
  // before the first chunk: the waiting ring at the status line (no Thinking section yet)
  await waitFor(() => liveOrb().length === 1 && liveOrb()[0].dataset.orb === 'ring', 'the waiting ring');
  assert.ok(liveOrb()[0].parentElement.classList.contains('msg'));
  stream.push(msgStart + block(0, 'thinking') + delta(0, { type: 'thinking_delta', thinking: 'Let me look.' }));
  // the waiting orb (a ring at the status line before the first chunk) moves into the Thinking summary
  await waitFor(() => liveOrb().length && liveOrb()[0].dataset.orb === 'ring' && liveOrb()[0].parentElement.tagName === 'SUMMARY', 'the ring');
  const orb = liveOrb()[0];
  assert.strictEqual(orb.getAttribute('aria-hidden'), 'true');
  assert.ok(!orb.classList.contains('hidden'));
  // in place of the summary's marker; the summary keeps its text and stays a summary (clickable, accessible)
  const sum = orb.parentElement;
  assert.strictEqual(sum.tagName, 'SUMMARY');
  assert.strictEqual(sum.firstElementChild, orb);
  assert.strictEqual(sum.textContent, 'Thinking…');
  const bubble = orb.closest('.msg');
  assert.ok(bubble.classList.contains('typing'));
  stream.push(delta(0, { type: 'thinking_delta', thinking: ' More thought.' }));
  await waitFor(() => bubble.querySelector('.thinking-body').textContent.includes('More'), 'more reasoning');
  stream.push(stop(0) + block(1, 'text') + delta(1, { type: 'text_delta', text: 'Searching ' }));
  await waitFor(() => orb.dataset.orb === 'ribbon', 'the ribbon');
  stream.push(delta(1, { type: 'text_delta', text: 'now.' }));
  await waitFor(() => bubble.querySelector('.md').textContent === 'Searching now.', 'more text');
  assert.strictEqual(bubble.querySelectorAll('canvas.orb').length, 1); // updated in place, never a second one
  stream.push(stop(1) + tu(2, 'toolu_o1', 'find_in_document', { query: 'Delta', doc: null }) + stopTool);
  stream.end();
  await waitFor(() => !state.busy, 'the end of the turn');
  await tick(10);
  // the first bubble's orb: ring -> ribbon -> null (the round ended) -> globe (the search runs) -> null (it finished)
  const modes = (c) => calls.filter(([x]) => x === c).map(([, m]) => m);
  assert.deepStrictEqual(modes(orb), ['ring', 'ribbon', null, 'globe', null]);
  assert.strictEqual(orb.parentElement, sum); // it stayed in the summary
  assert.ok(orb.classList.contains('hidden'));
  // the second round's bubble is made when its request starts (orb before the first chunk, test/dom/orb-wait.test.js):
  // its orb only waits or streams text and ends with the round
  const others = calls.filter(([c]) => c !== orb).map(([, m]) => m);
  assert.ok(others.every((m) => m === 'ring' || m === 'ribbon' || m === null) && (!others.length || others[others.length - 1] === null), JSON.stringify(others));
  // renderHistory replaced the live bubble: it is off the page (its loop ends), the new ones have no orb
  assert.ok(!orb.isConnected);
  assert.strictEqual($$('canvas.orb').length, 0);
  assert.ok($$('.msg.assistant .md').some((m) => m.textContent === 'Delta is on line 5.'));
  T.renderHistory();
  assert.strictEqual($$('canvas.orb').length, 0);
});

test('Stop: the turn\'s last bubble keeps one frozen frame of the orb, in its Thinking summary', async () => {
  const stream = liveStream();
  env.ctx.fetch = async (url, init) => {
    init.signal.addEventListener('abort', () => stream.fail(Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' })));
    return stream.response;
  };
  await send('Think about it');
  await waitFor(() => stream.reads > 0, 'the request');
  stream.push(msgStart + block(0, 'thinking') + delta(0, { type: 'thinking_delta', thinking: 'Hmm.' }));
  // the waiting orb (a ring at the status line before the first chunk) moves into the Thinking summary
  await waitFor(() => liveOrb().length && liveOrb()[0].dataset.orb === 'ring' && liveOrb()[0].parentElement.tagName === 'SUMMARY', 'the ring');
  const orb = liveOrb()[0];
  click(el.action); // Stop
  await waitFor(() => !state.busy, 'the stop');
  await tick(10);
  assert.ok(!orb.isConnected);
  const left = $$('canvas.orb');
  assert.strictEqual(left.length, 1);
  assert.strictEqual(left[0].dataset.orb, 'ring');
  assert.strictEqual(left[0].dataset.orbFrozen, 'true');
  assert.ok(!left[0].classList.contains('hidden'));
  assert.strictEqual(left[0].getAttribute('aria-hidden'), 'true');
  const last = $$('.msg.assistant').pop();
  assert.strictEqual(left[0].parentElement, last.querySelector('.thinking > summary'));
  assert.ok($$('.msg.assistant').every((b) => !b.classList.contains('typing')));
  // the next turn's re-render drops it
  T.renderHistory();
  assert.strictEqual($$('canvas.orb').length, 0);
});

test('an error: a frozen frame at the status line of the partial answer (no Thinking section)', async () => {
  const stream = liveStream();
  env.ctx.fetch = async () => stream.response;
  await send('Write something');
  await waitFor(() => stream.reads > 0, 'the request');
  stream.push(msgStart + block(0, 'text') + delta(0, { type: 'text_delta', text: 'Partial' }));
  await waitFor(() => liveOrb().length && liveOrb()[0].dataset.orb === 'ribbon', 'the ribbon');
  const orb = liveOrb()[0];
  stream.fail(new TypeError('Failed to fetch'));
  await waitFor(() => !state.busy, 'the failure');
  await tick(10);
  assert.ok($$('.msg.error').length >= 1);
  assert.ok(!orb.isConnected);
  const left = $$('canvas.orb');
  assert.strictEqual(left.length, 1);
  assert.strictEqual(left[0].dataset.orb, 'ribbon');
  assert.strictEqual(left[0].dataset.orbFrozen, 'true');
  const last = $$('.msg.assistant').pop();
  assert.strictEqual(left[0].parentElement, last);
  assert.strictEqual(left[0].nextElementSibling, last.querySelector('.agent-place'));
  assert.ok(last.querySelector('.thinking').classList.contains('hidden'));
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
  T.addNotice('Stopped.'); // not busy either
  assert.strictEqual($$('.msg.notice').pop().querySelector('canvas.orb'), null);
});
