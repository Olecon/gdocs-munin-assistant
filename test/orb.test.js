'use strict';
// The thinking orb (src/orb.js) alone in a vm context: the ported geometry against golden frames of the original
// (test/fixtures/orb-golden.json: six 20 px cases, one per mode, of thinking-orbs' spec/orbs-golden.json), the 20 px presets, and
// the canvas loop with a fake 2D context: always a loop (no reduced-motion rule), idempotent states, no drawing after
// the canvas leaves the page or after null, the hidden document, no context at all.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src/orb.js'), 'utf8');
const GOLDEN = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/orb-golden.json'), 'utf8'));

// A fake canvas: classes, attributes, isConnected and a 2D context that counts fills and clears.
function fakeCanvas({ withContext = true } = {}) {
  const classes = new Set();
  const attrs = {};
  const ctx = { fills: 0, clears: 0, fillStyle: '', globalAlpha: 1, transforms: [],
    setTransform(...a) { ctx.transforms.push(a); }, clearRect() { ctx.clears++; }, beginPath() {}, arc() {}, fill() { ctx.fills++; } };
  const c = {
    connected: true, width: 0, height: 0, contextCalls: 0, ctx,
    get isConnected() { return c.connected; },
    classList: {
      add: (...x) => x.forEach((k) => classes.add(k)), remove: (...x) => x.forEach((k) => classes.delete(k)),
      toggle: (k, f) => { const on = f === undefined ? !classes.has(k) : !!f; if (on) classes.add(k); else classes.delete(k); return on; },
      contains: (k) => classes.has(k),
    },
    get className() { return [...classes].join(' '); }, set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((k) => classes.add(k)); },
    setAttribute(k, v) { attrs[k] = String(v); }, getAttribute: (k) => (k in attrs ? attrs[k] : null), removeAttribute(k) { delete attrs[k]; },
    getContext() { c.contextCalls++; return withContext ? ctx : null; },
  };
  return c;
}

// orb.js in a fresh context. Animation frames queue up and run on frames(n); reduced: the media query result.
function loadOrb({ reduced = false, dpr = 1, motion = null } = {}) {
  const rafs = new Map();
  let nextId = 1;
  const listeners = {};
  const env = {
    reduced, motion, hidden: false, now: 1000,
    frames(n = 1) {
      for (let i = 0; i < n; i++) {
        const due = [...rafs.entries()];
        rafs.clear();
        for (const [, fn] of due) fn(env.now);
        env.now += 16;
      }
    },
    pending: () => rafs.size,
    fire(type) { for (const fn of listeners[type] || []) fn(); },
  };
  const document = {
    createElement: () => fakeCanvas(),
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    get visibilityState() { return env.hidden ? 'hidden' : 'visible'; },
    documentElement: { getAttribute: (k) => (k === 'data-motion' ? env.motion : null) }, // the Animations setting
  };
  const ctx = vm.createContext({
    Math, document, devicePixelRatio: dpr,
    performance: { now: () => env.now },
    matchMedia: (q) => ({ matches: q.includes('reduced-motion') && env.reduced }),
    getComputedStyle: () => ({ color: 'rgb(97, 82, 217)' }),
    requestAnimationFrame: (fn) => { const id = nextId++; rafs.set(id, fn); return id; },
    cancelAnimationFrame: (id) => { rafs.delete(id); },
  });
  vm.runInContext(SRC, ctx, { filename: 'src/orb.js' });
  env.T = new Proxy({}, { get: (_, name) => vm.runInContext(name, ctx) });
  return env;
}

test('geometry: the six 20 px modes match golden frames of thinking-orbs', () => {
  const { T } = loadOrb();
  assert.strictEqual(GOLDEN.cases.length, 6);
  assert.deepStrictEqual(GOLDEN.cases.map((c) => c.mode).sort(), ['globe', 'orbits', 'ribbon', 'ring', 'rubik', 'wave']);
  for (const c of GOLDEN.cases) {
    // the presets are the original's resolved 20 px options
    const preset = T.ORB_PRESETS[c.mode];
    assert.ok(preset, c.mode);
    for (const [k, v] of Object.entries(c.opts)) {
      if (k === 'rSizeMul') continue; // used only by modes we do not port
      assert.ok(Math.abs(preset.opts[k] - v) < 1e-9, `${c.key} ${k}`);
    }
    const dots = T.orbFrame(c.mode, c.t, c.size);
    assert.strictEqual(dots.length, c.dotCount, c.key);
    for (let i = 0; i < dots.length; i++) {
      const d = dots[i];
      const want = c.dots.slice(i * 6, i * 6 + 6);
      const got = [d.x, d.y, d.z, d.r, d.white, d.a ?? 1];
      got.forEach((v, j) => assert.ok(Math.abs(v - want[j]) <= GOLDEN.tolerance, `${c.key} dot ${i} field ${j}: ${v} vs ${want[j]}`));
    }
  }
  assert.deepStrictEqual(Object.keys(T.ORB_PRESETS).sort(), ['globe', 'orbits', 'ribbon', 'ring', 'rubik', 'wave']);
  assert.strictEqual(T.orbFrame('web', 1).length, 0); // not ported
});

test('orbCreate: a hidden decorative 20 px canvas', () => {
  const { T } = loadOrb();
  const c = T.orbCreate();
  assert.strictEqual(c.className, 'orb hidden');
  assert.strictEqual(c.getAttribute('aria-hidden'), 'true');
  assert.strictEqual(c.width, 20);
});

test('the orb always loops: reduced motion from the system and a stale data-motion change nothing', () => {
  for (const motion of ['off', null]) {
    const env = loadOrb({ reduced: true, motion });
    const c = fakeCanvas();
    env.T.orbSetState(c, 'ring');
    assert.strictEqual(env.pending(), 1, String(motion));
    env.frames(2);
    assert.ok(c.ctx.clears >= 3, String(motion));
    assert.strictEqual(c.ctx.fillStyle, 'rgb(97, 82, 217)'); // the CSS colour
  }
});

test('idempotent states; null hides the canvas and stops the loop', () => {
  const env = loadOrb();
  const c = fakeCanvas();
  env.T.orbSetState(c, 'ring');
  assert.strictEqual(c.getAttribute('data-orb'), 'ring');
  assert.ok(!c.classList.contains('hidden'));
  assert.strictEqual(env.pending(), 1);
  env.T.orbSetState(c, 'ring'); // no-op: still one loop, no extra frame
  env.T.orbSetState(c, 'ring');
  assert.strictEqual(env.pending(), 1);
  assert.strictEqual(c.ctx.clears, 1);
  env.frames(3);
  assert.strictEqual(c.ctx.clears, 4);
  assert.strictEqual(c.contextCalls, 1); // the context is asked once
  env.T.orbSetState(c, 'orbits');
  assert.strictEqual(c.getAttribute('data-orb'), 'orbits');
  assert.strictEqual(env.pending(), 1); // the old loop was cancelled, one new one
  env.T.orbSetState(c, null);
  assert.ok(c.classList.contains('hidden'));
  assert.strictEqual(c.getAttribute('data-orb'), null);
  assert.strictEqual(env.pending(), 0);
  const n = c.ctx.clears;
  env.frames(3);
  assert.strictEqual(c.ctx.clears, n);
  env.T.orbSetState(c, null); // still a no-op
  env.T.orbSetState(c, 'unknown'); // an unknown mode is null
  assert.strictEqual(env.pending(), 0);
});

test('the loop stops by itself once the canvas leaves the page', () => {
  const env = loadOrb({ dpr: 3 });
  const c = fakeCanvas();
  env.T.orbSetState(c, 'ribbon');
  assert.strictEqual(c.width, 40); // DPR capped at 2
  assert.deepStrictEqual(c.ctx.transforms[0], [2, 0, 0, 2, 0, 0]);
  env.frames(2);
  const n = c.ctx.clears;
  c.connected = false; // the bubble was replaced (renderHistory, chat switch)
  env.frames(1);
  assert.strictEqual(c.ctx.clears, n);
  assert.strictEqual(env.pending(), 0);
  env.frames(3);
  assert.strictEqual(c.ctx.clears, n);
});

test('a hidden document pauses the loop; visible again resumes it', () => {
  const env = loadOrb();
  const c = fakeCanvas();
  env.T.orbSetState(c, 'orbits');
  env.hidden = true;
  env.frames(1); // the frame notices and does not reschedule
  assert.strictEqual(env.pending(), 0);
  const n = c.ctx.clears;
  env.fire('visibilitychange');
  assert.strictEqual(env.pending(), 0);
  env.hidden = false;
  env.fire('visibilitychange');
  assert.strictEqual(c.ctx.clears, n + 1);
  assert.strictEqual(env.pending(), 1);
  env.T.orbSetState(c, null);
  env.fire('visibilitychange');
  assert.strictEqual(env.pending(), 0);
});

test('no 2D context (jsdom): only the attribute and the hidden class change, no loop, no exception', () => {
  const env = loadOrb();
  const c = fakeCanvas({ withContext: false });
  env.T.orbSetState(c, 'ring');
  assert.strictEqual(c.getAttribute('data-orb'), 'ring');
  assert.ok(!c.classList.contains('hidden'));
  assert.strictEqual(env.pending(), 0);
  env.T.orbSetState(c, 'ribbon');
  env.T.orbSetState(c, null);
  assert.ok(c.classList.contains('hidden'));
  assert.strictEqual(c.contextCalls, 1);
  env.T.orbSetState(null, 'ring'); // no canvas: ignored
});

test('rubik: the bands are scrambled mid-cycle and solved again at the rest (the snap means verified)', () => {
  const { T } = loadOrb();
  // cycle: 2 × 14 moves × 0.42 + 1.2 rest = 12.96; t = 12.0 is in the rest, t = 5.0 in the scramble
  const solved = T.orbFrame('rubik', 12.0);
  const scrambled = T.orbFrame('rubik', 5.0);
  assert.strictEqual(solved.length, 30);
  assert.strictEqual(scrambled.length, 30);
  // no band is in motion during the rest: no dot carries the active ink; mid-scramble some do
  const plainInk = (d) => Math.abs(d.white - (0.62 - 0.54 * ((d.z + 1) / 2))) < 1e-9;
  assert.ok(solved.every(plainInk));
  assert.ok(scrambled.some((d) => !plainInk(d)));
});

test('frozen: one still frame of the mode, no loop, marked; a live mode afterwards loops again', () => {
  const env = loadOrb();
  const c = fakeCanvas();
  env.T.orbSetState(c, 'ribbon');
  assert.strictEqual(env.pending(), 1);
  env.T.orbSetState(c, 'ribbon', { frozen: true });
  assert.strictEqual(env.pending(), 0);
  assert.strictEqual(c.getAttribute('data-orb'), 'ribbon');
  assert.strictEqual(c.getAttribute('data-orb-frozen'), 'true');
  assert.ok(!c.classList.contains('hidden'));
  const n = c.ctx.clears;
  env.frames(3);
  assert.strictEqual(c.ctx.clears, n); // nothing more is drawn
  env.T.orbSetState(c, 'ribbon', { frozen: true }); // idempotent
  assert.strictEqual(c.ctx.clears, n);
  env.T.orbSetState(c, 'wave');
  assert.strictEqual(c.getAttribute('data-orb-frozen'), null);
  assert.strictEqual(env.pending(), 1);
  env.T.orbSetState(c, null, { frozen: true }); // null wins: hidden, not frozen
  assert.ok(c.classList.contains('hidden'));
  assert.strictEqual(c.getAttribute('data-orb-frozen'), null);
});
