'use strict';
// The streaming render coordinator (src/stream-render.js): coalescing to the latest snapshot, the adaptive
// minimum interval, flush, a throwing render, cancellation; and its wiring into a real turn (toolLoop), where
// chunks between two frames are painted once with the latest text and the final text is never stale.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { load, installDocTab, waitFor, tabExportOnly } = require('./lib/sandbox');
const { ev, msgStart } = require('./lib/streams');
const { liveStream } = require('./lib/live-stream');

let env, T, state, sandbox;

before(async () => {
  env = await load();
  ({ T, state, ctx: sandbox } = env);
  installDocTab(env);
  env.chrome.tabs.sendMessage = async (id, msg) => {
    if (msg.type === 'GET_SELECTION') return { ok: true, text: '' };
    if (msg.type === 'GET_DOC_TEXT') return { ok: true, text: '# Doc\n\nSome text.', format: 'markdown', title: 'My Doc' };
    return { ok: true, title: 'My Doc' };
  };
  await T.refreshContext({ force: true });
  state.googleConnected = false;
});

// A fake clock and scheduler: scheduled ticks wait in a queue; run() advances the clock to each tick's due time
// (at least one frame later) and runs it. cost: how long each render takes on the fake clock.
function bench({ cost = () => 1, throwOn = () => false } = {}) {
  const b = { t: 1000, queue: [], renders: [] };
  b.now = () => b.t;
  b.schedule = (fn, delay) => { b.queue.push({ fn, at: b.t + Math.max(delay, 16) }); };
  b.run = () => {
    while (b.queue.length) {
      const { fn, at } = b.queue.shift();
      if (at > b.t) b.t = at;
      fn();
    }
  };
  b.coord = T.createRenderCoordinator((s) => {
    b.renders.push(s);
    b.t += cost(b.renders.length);
    if (throwOn(b.renders.length)) throw new Error('render failed');
  }, { now: b.now, schedule: b.schedule });
  return b;
}

test('the bounds are constants: 16 ms to 250 ms', () => {
  assert.strictEqual(T.STREAM_RENDER_MIN_MS, 16);
  assert.strictEqual(T.STREAM_RENDER_MAX_MS, 250);
});

test('rapid updates are coalesced: one render per tick, with the latest snapshot', () => {
  const b = bench();
  for (let i = 1; i <= 50; i++) b.coord.update({ text: 'x'.repeat(i) });
  assert.strictEqual(b.queue.length, 1, 'one tick scheduled, not one per update');
  b.run();
  assert.strictEqual(b.renders.length, 1);
  assert.strictEqual(b.renders[0].text.length, 50);
  // Updates between ticks: still far fewer renders than updates, and the last one shows the last update.
  for (let i = 51; i <= 100; i++) { b.coord.update({ text: 'x'.repeat(i) }); if (i % 10 === 0) b.run(); }
  assert.ok(b.renders.length <= 6, `${b.renders.length} renders for 100 updates`);
  assert.strictEqual(b.renders[b.renders.length - 1].text.length, 100);
  const n = b.renders.length;
  b.run();
  assert.strictEqual(b.renders.length, n, 'nothing left to render');
});

test('the minimum interval follows 2 × the last render, clamped, and shrinks back after fast renders', () => {
  const costs = [1, 60, 500, 2, 2];
  const b = bench({ cost: (n) => costs[n - 1] });
  const step = (text) => {
    const before = b.t;
    b.coord.update({ text });
    b.run();
    return b.t - before;
  };
  step('a');
  assert.strictEqual(b.coord.interval(), 16, 'a fast render keeps the minimum');
  step('b');
  assert.strictEqual(b.coord.interval(), 120, 'a 60 ms render: 120 ms');
  // The next render waits for the interval since the slow render started.
  const startOfSlow = b.t - 60;
  b.coord.update({ text: 'c' });
  assert.ok(b.queue[0].at >= startOfSlow + 120, 'scheduled no sooner than 120 ms after the previous render started');
  b.run();
  assert.strictEqual(b.coord.interval(), 250, 'a 500 ms render: clamped to 250 ms');
  step('d');
  assert.strictEqual(b.coord.interval(), 16, 'back to the minimum after a fast render');
  assert.deepStrictEqual(b.renders.map((s) => s.text), ['a', 'b', 'c', 'd']);
});

test('flush renders the pending snapshot at once and is idempotent; the scheduled tick then does nothing', () => {
  const b = bench();
  assert.strictEqual(b.coord.flush(), false, 'nothing pending');
  b.coord.update({ text: 'one' });
  b.coord.update({ text: 'two' });
  assert.strictEqual(b.coord.flush(), true);
  assert.deepStrictEqual(b.renders.map((s) => s.text), ['two']);
  assert.strictEqual(b.coord.flush(), false);
  b.run();
  assert.strictEqual(b.renders.length, 1, 'the tick scheduled before the flush did not render again');
  // An update after the flush is still rendered by that tick (or the next one).
  b.coord.update({ text: 'three' });
  b.run();
  assert.deepStrictEqual(b.renders.map((s) => s.text), ['two', 'three']);
});

test('a throwing render counts as consumed: one warning, the stream goes on to its final text', () => {
  const warnings = [];
  const realWarn = sandbox.console.warn;
  sandbox.console = { ...sandbox.console, warn: (...a) => warnings.push(a) };
  try {
    const b = bench({ throwOn: () => true });
    b.coord.update({ text: 'a' });
    b.run();
    b.coord.update({ text: 'ab' });
    b.run();
    b.coord.update({ text: 'abc' });
    assert.strictEqual(b.coord.flush(), true);
    assert.strictEqual(b.coord.flush(), false, 'the failed snapshot is not retried');
    assert.deepStrictEqual(b.renders.map((s) => s.text), ['a', 'ab', 'abc']);
    assert.strictEqual(warnings.length, 1, 'warned once');
  } finally {
    sandbox.console = { ...sandbox.console, warn: realWarn };
  }
});

test('cancel: a tick scheduled before it does nothing; the coordinator works again afterwards', () => {
  const b = bench();
  b.coord.update({ text: 'stale' });
  b.coord.cancel();
  assert.strictEqual(b.coord.flush(), false, 'nothing pending after cancel');
  b.coord.update({ text: 'fresh' }); // a new generation schedules its own tick
  b.run();
  assert.deepStrictEqual(b.renders.map((s) => s.text), ['fresh'], 'the stale tick did not render');
  b.coord.update({ text: 'gone' });
  b.coord.cancel();
  b.run();
  assert.deepStrictEqual(b.renders.map((s) => s.text), ['fresh']);
});

test('cancel clears the pending timer and frame of the default scheduler', () => {
  const saved = ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'].map((k) => [k, sandbox[k]]);
  const timers = new Map(); const frames = new Map(); let seq = 0;
  Object.assign(sandbox, {
    setTimeout: (fn) => { timers.set(++seq, fn); return seq; },
    clearTimeout: (id) => { timers.delete(id); },
    requestAnimationFrame: (fn) => { frames.set(++seq, fn); return seq; },
    cancelAnimationFrame: (id) => { frames.delete(id); },
  });
  try {
    const seen = [];
    let t = 0;
    const coord = T.createRenderCoordinator((s) => seen.push(s.text), { now: () => t });
    coord.update({ text: 'a' }); // the first tick: a frame at once
    assert.strictEqual(frames.size, 1);
    coord.cancel();
    assert.strictEqual(frames.size, 0, 'the frame is cancelled');
    coord.update({ text: 'b' });
    [...frames.values()][0](); frames.clear(); // renders "b" at t = 0
    coord.update({ text: 'c' }); // within the minimum interval: a delay timer first
    assert.strictEqual(timers.size, 1);
    coord.cancel();
    assert.strictEqual(timers.size + frames.size, 0, 'the delay timer is cleared');
    t = 1000;
    assert.deepStrictEqual(seen, ['b']);
  } finally {
    for (const [k, v] of saved) { if (v === undefined) delete sandbox[k]; else sandbox[k] = v; }
  }
});

test('without requestAnimationFrame the default scheduler falls back to a timer', async () => {
  const saved = sandbox.requestAnimationFrame;
  delete sandbox.requestAnimationFrame;
  try {
    const seen = [];
    const coord = T.createRenderCoordinator((s) => seen.push(s.text));
    coord.update({ text: 'a' });
    coord.update({ text: 'b' });
    await waitFor(() => seen.length > 0, 'the fallback timer');
    assert.deepStrictEqual(seen, ['b']);
  } finally {
    sandbox.requestAnimationFrame = saved;
  }
});

test('in a turn: chunks between frames are painted once with the latest text; the final text is not stale', async () => {
  state.settings.provider = 'anthropic';
  Object.assign(state.settings.providers.anthropic, { apiKey: 'sk-ant-x', model: 'claude-opus-5-5' });
  await T.createChat();
  // Frames run only when the test says so.
  const frames = [];
  const savedRaf = sandbox.requestAnimationFrame;
  sandbox.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
  const paints = [];
  sandbox.__paints = paints;
  env.run('(() => { const orig = updateAssistantBubble; updateAssistantBubble = function (b, o) { __paints.push({ text: o.text, streaming: !!o.streaming }); return orig(b, o); }; globalThis.__restorePaint = () => { updateAssistantBubble = orig; }; })()');
  try {
    const stream = liveStream();
    sandbox.fetch = tabExportOnly(async () => stream.response);
    const delta = (t) => ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } });
    T.el.chat.children.length = 0;
    T.el.input.value = 'Count';
    const turn = T.sendMessage();
    await waitFor(() => stream.reads > 0, 'the stream');
    stream.push(msgStart + ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    const words = [];
    for (let i = 1; i <= 20; i++) {
      words.push('w' + i);
      stream.push(delta('w' + i + ' '));
      await waitFor(() => stream.reads > i + 1, 'chunk ' + i);
    }
    assert.strictEqual(frames.length, 1, 'one frame requested for 20 chunks');
    assert.strictEqual(paints.length, 0, 'nothing painted before the frame');
    frames.shift()();
    assert.strictEqual(paints.length, 1);
    assert.strictEqual(paints[0].text, words.join(' ') + ' ', 'the frame paints the latest text');
    stream.push(delta('end.') + ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }) + ev('message_stop', { type: 'message_stop' }));
    stream.end();
    await turn;
    const streamed = paints.filter((p) => p.streaming);
    assert.strictEqual(streamed[streamed.length - 1].text, words.join(' ') + ' end.', 'flushed at the end of the stream');
    const last = state.messages[state.messages.length - 1];
    assert.strictEqual(last.content, words.join(' ') + ' end.');
    for (const fn of frames) fn(); // frames requested before the end: nothing more is painted
    assert.strictEqual(paints.filter((p) => p.streaming).length, streamed.length);
  } finally {
    env.run('__restorePaint()');
    sandbox.requestAnimationFrame = savedRaf;
  }
});
