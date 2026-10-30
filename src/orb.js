'use strict';
// Module orb.js: the "thinking orb", a 20 px animated dot sphere in the live assistant bubble (render.js sets
// its state from the stream). Six modes: ring (waiting, reasoning), orbits (a tool runs), ribbon (text streams),
// wave (listening: the panel waits on the user), rubik (solving: a write; the bands click back into place; its
// verifying re-read shows the ring), globe (searching: web search, find_in_document); plus a frozen frame (no loop)
// for a stopped or failed turn.
//
// Ported from thinking-orbs (https://github.com/Jakubantalik/thinking-orbs, src/engine/core.ts, orbits.ts,
// ribbon.ts, lattice.ts, the 20 px presets of presets.ts / profiles.ts), Copyright (c) 2026 Jakub Antalik, MIT License:
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
//   associated documentation files (the "Software"), to deal in the Software without restriction, including
//   without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//   copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the
//   following conditions:
//
//   The above copyright notice and this permission notice shall be included in all copies or substantial
//   portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
//   LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
//   EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN
//   AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE
//   OR OTHER DEALINGS IN THE SOFTWARE.
//
// Changes from the original: plain JS, only the ring / orbits / ribbon / wave / rubik / globe geometry and the 20 px
// presets (resolved values, as in spec/orbs-golden.json), and the painter draws every dot in the canvas's CSS `color` with the
// dot's ink value as alpha (instead of grey levels mirrored for dark themes), so the theme tokens decide the
// colour. The geometry itself is unchanged: test/orb.test.js checks it against golden frames of the original.
// No top-level dependencies (loaded before render.js).
/* exported orbCreate, orbSetState, orbFrame, ORB_PRESETS, ORB_SIZE */

const ORB_SIZE = 20; // CSS px (the original's tuned 20 px preset)
const ORB_DPR_MAX = 2;
const ORB_STATIC_T = 0.6; // the frozen frame (as the original's static one)
const ORB_COLOR_EVERY = 30; // frames between re-reads of the CSS colour (follows a theme toggle within ~0.5 s)

// The 20 px presets, resolved (thinking-orbs 0.3.1: breathing-20, working-20, composing-20, listening-20, solving-20,
// searching-20; spec/orbs-golden.json "resolved"). speed scales the clock.
const ORB_PRESETS = {
  ring: { speed: 3.78, opts: { lanes: 2, segs: 15, ghostN: 0, faceOn: 1, rBase: 1.7842, rDepth: 2.7574, rsPow: 0.6, rMin: 0.3, spin: 0, bandMul: 3.968, wobMul: 0.565 } },
  orbits: { speed: 3.9, opts: { orbitN: 3, ghostN: 10, ghostR: 2.16, ghostA: 0.5, particles: 3, partR: 2.88, partRDepth: 3.84, rsPow: 0.6, rMin: 0.3 } },
  ribbon: { speed: 3.12, opts: { lanes: 2, segs: 20, ghostN: 8, rBase: 1.1803, rDepth: 1.8241, rsPow: 0.6, rMin: 0.3, spin: 0, bandMul: 4.94, wobMul: 1 } },
  wave: { speed: 3.998, opts: { rings: 5, lonDensity: 13, rBase: 0.96, rDepth: 2.72, rsPow: 0.6, rMin: 0.3 } },
  rubik: { speed: 1.95, opts: { latRings: 4, lonDensity: 12, moveCount: 14, rBase: 1.14, rDepth: 3.23, rActive: 0.57, inkFar: 0.62, inkSpan: 0.54, rsPow: 0.6, rMin: 0.3 } },
  globe: { speed: 2.665, opts: { latRings: 6, lonDensity: 14, rBase: 1.05, rDepth: 2.975, rBoost: 1, inkFar: 0.62, inkSpan: 0.54, rsPow: 0.6, rMin: 0.3, scanMul: 4.335, dimBase: 0.45 } },
};

// ---- Geometry (core.ts) --------------------------------------------------------------------------
// Deterministic hash in [0, 1).
function orbHash(a, b) {
  const h = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return h - Math.floor(h);
}
// Stable directions on a unit sphere (Fibonacci lattice).
function orbFibDir(i, n) {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const y = 1 - (2 * (i + 0.5)) / n;
  const rad = Math.sqrt(1 - y * y);
  const a = i * golden;
  return [rad * Math.cos(a), y, rad * Math.sin(a)];
}
// Spin + tilt + orthographic projection: (x, y, z) -> [screen x, screen y, depth].
function orbProj(yaw, tilt, cx, cy, scale) {
  const st = Math.sin(tilt), ct = Math.cos(tilt), sy = Math.sin(yaw), cyw = Math.cos(yaw);
  return (x, y, z) => {
    const x1 = x * cyw + z * sy;
    const z1 = -x * sy + z * cyw;
    const y1 = y * ct - z1 * st;
    const z2 = y * st + z1 * ct;
    return [cx + x1 * scale, cy - y1 * scale, z2];
  };
}
// Dot radii were tuned for a 300 px frame; sub-linear scaling keeps small orbs legible.
const orbRadiusScale = (size, pow) => (size / 300) ** pow;
// Drops invisible dots, clamps radii, z-sorts far -> near (the draw order).
function orbFinalize(dots, rMin = 0.3) {
  const visible = [];
  for (const d of dots) {
    if ((d.a ?? 1) < 0.02) continue;
    d.r = Math.max(rMin, d.r);
    visible.push(d);
  }
  visible.sort((a, b) => a.z - b.z);
  return visible;
}

// ---- Orbits (orbits.ts): particles on tilted orbits with their ghost paths ----------------------------
function orbFrameOrbits(size, t, o) {
  const cx = size / 2, cy = size / 2;
  const R = (size / 2) * 0.82;
  const pt = orbProj(t * 0.12, 0.3, cx, cy, 1);
  const rs = orbRadiusScale(size, o.rsPow ?? 0.6);
  const dots = [];
  const orbitN = o.orbitN ?? 12, ghostN = o.ghostN ?? 40, particles = o.particles ?? 3;
  for (let orb = 0; orb < orbitN; orb++) {
    const h1 = orbHash(orb, 1.7), h2 = orbHash(orb, 5.2), h3 = orbHash(orb, 8.9);
    const ro = R * (0.45 + 0.52 * h1);
    const th = h1 * 2 * Math.PI;
    const phi = Math.acos(2 * h2 - 1);
    // orbit plane basis (u, v perpendicular to the normal n)
    const nx = Math.sin(phi) * Math.cos(th), ny = Math.cos(phi), nz = Math.sin(phi) * Math.sin(th);
    let ux = -ny, uy = nx;
    const uz = 0;
    const ul = Math.max(1e-6, Math.sqrt(ux * ux + uy * uy));
    ux /= ul; uy /= ul;
    const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
    const speed = (0.25 + 0.55 * h3) * (h3 > 0.5 ? 1 : -1);
    const at = (a) => pt((ux * Math.cos(a) + vx * Math.sin(a)) * ro, (uy * Math.cos(a) + vy * Math.sin(a)) * ro, (uz * Math.cos(a) + vz * Math.sin(a)) * ro);
    for (let k = 0; k < ghostN; k++) { // ghost path
      const [x, y, z] = at((k / ghostN) * 2 * Math.PI);
      const depth = (z / ro + 1) / 2;
      dots.push({ x, y, z, r: (o.ghostR ?? 0.9) * rs, white: 0.72, a: (o.ghostA ?? 0.5) * (0.4 + 0.6 * depth) });
    }
    for (let m = 0; m < particles; m++) { // the particles doing the work
      const [x, y, z] = at(t * speed + (m / particles) * 2 * Math.PI + h2 * 6);
      const depth = (z / ro + 1) / 2;
      dots.push({ x, y, z, r: ((o.partR ?? 1.2) + (o.partRDepth ?? 1.6) * depth) * rs, white: 0.3 - 0.22 * depth });
    }
  }
  return orbFinalize(dots, o.rMin);
}

// ---- Ribbon and ring (ribbon.ts): an undulating band of strands on a great circle; faceOn turns it into a
// face-on ring whose radius breathes ------------------------------------------------------------------
function orbFrameRibbon(size, t, o) {
  const cx = size / 2, cy = size / 2;
  const R = (size / 2) * 0.78;
  const spin = o.spin ?? 1;
  const camTilt = 0.3;
  const pt = orbProj(t * 0.1 * spin, camTilt, cx, cy, 1);
  const rs = orbRadiusScale(size, o.rsPow ?? 0.6);
  const dots = [];
  const ghostN = o.ghostN ?? 150;
  for (let i = 0; i < ghostN; i++) { // faint ghost sphere
    const d = orbFibDir(i, ghostN);
    const [x, y, z] = pt(d[0] * R, d[1] * R, d[2] * R);
    const depth = (z / R + 1) / 2;
    dots.push({ x, y, z, r: 0.8 * rs, white: 0.78, a: 0.1 + 0.22 * depth });
  }
  // The band plane (frozen when spin = 0); face-on cancels the camera tilt so the band reads as a true circle.
  const ya = t * 0.24 * spin;
  const ta = o.faceOn ? -camTilt : 0.55 + 0.3 * Math.sin(t * 0.18) * spin;
  const ux = Math.cos(ya), uy = 0, uz = Math.sin(ya);
  const vx = -uz * Math.sin(ta), vy = Math.cos(ta), vz = ux * Math.sin(ta);
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  // Face-on lobes swell past R: the base radius is pulled in by most of the wobble amplitude.
  const wobAmp = 0.23 * (o.wobMul ?? 1);
  const baseR = o.faceOn ? R / (1 + 0.85 * wobAmp) : R;
  const segs = o.segs ?? 88;
  const lanes = Math.max(1, Math.round((o.lanes ?? 5) * (o.bandMul ?? 1)));
  for (let w = 0; w < lanes; w++) {
    const laneOff = (w - (lanes - 1) / 2) * 0.075;
    const edge = Math.abs(w - (lanes - 1) / 2) / Math.max(1, (lanes - 1) / 2);
    for (let k = 0; k < segs; k++) {
      const a = (k / segs) * 2 * Math.PI;
      // two traveling waves along the band; face-on moves them onto the radius, the ribbon keeps the sash wobble
      const wob = (0.16 * Math.sin(a * 3 - t * 1.7 + w * 0.22) + 0.07 * Math.sin(a * 5 + t * 1.1)) * (o.wobMul ?? 1);
      const radial = o.faceOn ? 1 + wob : 1;
      const off = o.faceOn ? laneOff : laneOff + wob;
      const x = ux * Math.cos(a) + vx * Math.sin(a) + nx * off;
      const y = uy * Math.cos(a) + vy * Math.sin(a) + ny * off;
      const z = uz * Math.cos(a) + vz * Math.sin(a) + nz * off;
      const l = Math.sqrt(x * x + y * y + z * z);
      const rr = baseR * radial;
      const [px, py, zr] = pt((x / l) * rr, (y / l) * rr, (z / l) * rr);
      const depth = (zr / R + 1) / 2;
      dots.push({ x: px, y: py, z: zr, r: ((o.rBase ?? 1.1) + (o.rDepth ?? 1.7) * depth) * (1 - 0.25 * edge) * rs,
        white: 0.52 - 0.44 * depth + 0.18 * edge, a: 0.4 + 0.6 * depth });
    }
  }
  return orbFinalize(dots, o.rMin);
}

// ---- The sphere-lattice modes (lattice.ts): a lat/long dot field with mode-specific motion ------------------
// Shortest signed angular distance, wrapped to (-pi, pi].
const orbAngleDelta = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
// Calls fn(cosLat, sinLat, lon, ring) for every dot of a lat/long field of `rings` + 1 rings.
function orbLattice(rings, lonDensity, fn) {
  for (let li = 0; li <= rings; li++) {
    const lat = -Math.PI / 2 + (li / rings) * Math.PI;
    const cosLat = Math.cos(lat), sinLat = Math.sin(lat);
    const lonCount = Math.max(1, Math.round(Math.abs(cosLat) * lonDensity));
    for (let lj = 0; lj < lonCount; lj++) fn(cosLat, sinLat, (lj / lonCount) * 2 * Math.PI, li);
  }
}

// Globe (searching): the sphere spins while a scan meridian sweeps across it as a size ripple.
function orbFrameGlobe(size, t, o) {
  const spin = 0.5;
  const pt = orbProj(t * spin, 0.4 + 0.06 * Math.sin(t * 0.35), size / 2, size / 2, (size / 2) * 0.82);
  const scan = t * (spin + (1.7 - spin) * (o.scanMul ?? 1)); // relative to the spin
  const rs = orbRadiusScale(size, o.rsPow ?? 0.6);
  const dimBase = o.dimBase ?? 1;
  const dots = [];
  orbLattice(o.latRings ?? 17, o.lonDensity ?? 44, (cosLat, sinLat, lon) => {
    const [x, y, z] = pt(cosLat * Math.cos(lon), sinLat, cosLat * Math.sin(lon));
    const depth = (z + 1) / 2;
    const d = orbAngleDelta(lon + t * spin, scan);
    const boost = Math.exp(-(d * d) / 0.18) * Math.max(0, z);
    dots.push({ x, y, z, r: ((o.rBase ?? 0.6) + (o.rDepth ?? 1.7) * depth + (o.rBoost ?? 1) * boost) * rs,
      white: (o.inkFar ?? 0.62) - (o.inkSpan ?? 0.54) * depth, a: dimBase + (1 - dimBase) * Math.min(1, boost) });
  });
  return orbFinalize(dots, o.rMin);
}

// Rubik (solving): quarter turns of bands scramble the sphere, then replay in reverse so everything clicks back to
// solved, rests, repeats. solveCycle: how far each move is turned at time t, and the move in progress.
function orbSolveCycle(time, count, slotDur, rest) {
  const cyc = 2 * count * slotDur + rest;
  const tc = time % cyc;
  const amount = new Array(count).fill(0);
  let active = -1;
  if (tc < 2 * count * slotDur) {
    const slot = Math.floor(tc / slotDur);
    const p = (tc - slot * slotDur) / slotDur;
    const ep = 1 - (1 - Math.min(1, p / 0.7)) ** 3; // machine ease-out
    if (slot < count) {
      for (let i = 0; i < slot; i++) amount[i] = 1;
      amount[slot] = ep;
      active = slot;
    } else {
      const u = 2 * count - 1 - slot;
      for (let i = 0; i < u; i++) amount[i] = 1;
      amount[u] = 1 - ep;
      active = u;
    }
  }
  return { amount, active };
}
function orbMoves(count) {
  const moves = [];
  for (let i = 0; i < count; i++) {
    const axis = Math.min(2, Math.floor(orbHash(i, 2.3) * 3));
    const lo = -1.0 + 0.5 * Math.min(3, Math.floor(orbHash(i, 5.9) * 4));
    moves.push({ axis, lo, hi: lo + 0.5, ang: ((orbHash(i, 7.7) < 0.5 ? 1 : -1) * Math.PI) / 2 });
  }
  return moves;
}
function orbApplyMoves(p3, moves, sc) {
  let [x, y, z] = p3;
  let inActive = false;
  for (let i = 0; i < moves.length; i++) {
    if (sc.amount[i] <= 0) continue;
    const mv = moves[i];
    const coord = mv.axis === 0 ? x : mv.axis === 1 ? y : z;
    if (coord < mv.lo || coord >= mv.hi) continue;
    if (i === sc.active) inActive = true;
    const a = mv.ang * sc.amount[i];
    const ca = Math.cos(a), sa = Math.sin(a);
    if (mv.axis === 0) { const y2 = y * ca - z * sa; z = y * sa + z * ca; y = y2; }
    else if (mv.axis === 1) { const x2 = x * ca + z * sa; z = -x * sa + z * ca; x = x2; }
    else { const x2 = x * ca - y * sa; y = x * sa + y * ca; x = x2; }
  }
  return [x, y, z, inActive];
}
function orbFrameRubik(size, t, o) {
  const pt = orbProj(t * 0.55, 0.35 + 0.1 * Math.sin(t * 0.9), size / 2, size / 2, (size / 2) * 0.82);
  const rs = orbRadiusScale(size, o.rsPow ?? 0.6);
  const moveCount = o.moveCount ?? 14;
  const moves = orbMoves(moveCount);
  const sc = orbSolveCycle(t, moveCount, 0.42, 1.2);
  const dots = [];
  orbLattice(o.latRings ?? 15, o.lonDensity ?? 40, (cosLat, sinLat, lon) => {
    const [x, y, z, inActive] = orbApplyMoves([cosLat * Math.cos(lon), sinLat, cosLat * Math.sin(lon)], moves, sc);
    const [px, py, zr] = pt(x, y, z);
    const depth = (zr + 1) / 2;
    // the band being turned inks a touch darker: the "hand"
    dots.push({ x: px, y: py, z: zr, r: ((o.rBase ?? 0.6) + (o.rDepth ?? 1.7) * depth + (inActive ? (o.rActive ?? 0.3) : 0)) * rs,
      white: (o.inkFar ?? 0.62) - (o.inkSpan ?? 0.54) * depth - (inActive ? 0.14 : 0) });
  });
  return orbFinalize(dots, o.rMin);
}

// Wave (listening): a waveform rolls through the rings (two waves at different tempi).
function orbFrameWave(size, t, o) {
  const R = (size / 2) * 0.874; // the undulation pulls the sphere in; scaled up to match the other lattice modes
  const pt = orbProj(t * 0.18, 0.38, size / 2, size / 2, 1);
  const rs = orbRadiusScale(size, o.rsPow ?? 0.6);
  const dots = [];
  let ring = -1, w = 0, rr = R;
  orbLattice(o.rings ?? 15, o.lonDensity ?? 40, (cosLat, sinLat, lon, ri) => {
    if (ri !== ring) {
      ring = ri;
      w = 0.62 * Math.sin(t * 2.1 - ri * 0.52) + 0.38 * Math.sin(t * 1.27 + ri * 0.83);
      rr = R * (0.88 + 0.105 * w);
    }
    const [x, y, z] = pt(cosLat * Math.cos(lon) * rr, sinLat * rr, cosLat * Math.sin(lon) * rr);
    const depth = (z / R + 1) / 2;
    const crest = Math.max(0, w);
    dots.push({ x, y, z, r: ((o.rBase ?? 0.6) + (o.rDepth ?? 1.7) * depth) * (1 + 0.4 * crest) * rs, white: 0.66 - 0.56 * depth - 0.1 * crest });
  });
  return orbFinalize(dots, o.rMin);
}

const ORB_FRAMES = { ring: orbFrameRibbon, ribbon: orbFrameRibbon, orbits: orbFrameOrbits, wave: orbFrameWave, rubik: orbFrameRubik, globe: orbFrameGlobe };
// The z-sorted dots of one mode at time t (preset time units, not seconds), at size CSS px.
function orbFrame(mode, t, size = ORB_SIZE) {
  const p = ORB_PRESETS[mode];
  if (!p) return [];
  return ORB_FRAMES[mode](size, t, p.opts);
}

// ---- The canvas ----------------------------------------------------------------------------------
// Per-canvas state: { canvas, mode, ctx (undefined: not asked yet; null: no 2D context), color, dpr, raf, frames }.
const orbStates = new WeakMap();
const orbRunning = new Set(); // states with a loop (paused while the document is hidden)
let orbVisibilityHooked = false;

// The decorative canvas (the bubble's own text says what is going on); hidden until a mode is set.
function orbCreate() {
  const c = document.createElement('canvas');
  c.className = 'orb hidden';
  c.setAttribute('aria-hidden', 'true');
  c.width = ORB_SIZE;
  c.height = ORB_SIZE;
  return c;
}

const orbNow = () => (typeof performance !== 'undefined' && performance && typeof performance.now === 'function' ? performance.now() : Date.now());
const orbHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

// The 2D context, asked once per canvas (jsdom and odd environments: null, then only the attributes change).
function orbContext(st) {
  if (st.ctx === undefined) {
    try { st.ctx = st.canvas.getContext('2d') || null; } catch (e) { st.ctx = null; }
  }
  return st.ctx;
}
function orbReadColor(st) {
  try { st.color = getComputedStyle(st.canvas).color || st.color; } catch (e) { /* keep the last colour */ }
}

// Paints one frame: every dot in the CSS colour, its ink value (0 = darkest) turned into alpha.
function orbDraw(st, t) {
  const ctx = st.ctx;
  const dpr = st.dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, ORB_SIZE, ORB_SIZE);
  ctx.fillStyle = st.color;
  for (const d of orbFrame(st.mode, t)) {
    ctx.globalAlpha = (d.a ?? 1) * (1 - Math.min(1, Math.max(0, d.white)));
    ctx.beginPath();
    ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function orbStop(st) {
  if (st.raf != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(st.raf);
  st.raf = null;
  orbRunning.delete(st);
}
// One requestAnimationFrame loop per live orb; it ends by itself once the canvas leaves the page.
function orbTick(st) {
  st.raf = null;
  if (!st.canvas.isConnected || !st.mode) { orbStop(st); return; }
  if (orbHidden()) return; // stays in orbRunning; visibilitychange restarts it
  if (++st.frames % ORB_COLOR_EVERY === 0) orbReadColor(st);
  orbDraw(st, (orbNow() / 1000) * ORB_PRESETS[st.mode].speed); // one shared clock: every orb in phase
  st.raf = requestAnimationFrame(() => orbTick(st));
}
function orbStart(st) {
  orbRunning.add(st);
  if (!orbVisibilityHooked && typeof document !== 'undefined' && document.addEventListener) {
    orbVisibilityHooked = true;
    document.addEventListener('visibilitychange', () => {
      for (const s of [...orbRunning]) {
        if (!s.canvas.isConnected) orbStop(s);
        else if (!orbHidden() && s.raf == null) orbTick(s);
      }
    });
  }
  orbTick(st);
}

// Sets the orb's mode: 'ring' | 'orbits' | 'ribbon' | 'wave' | 'rubik' | 'globe', or null (hidden, no loop).
// opts.frozen: one still frame of the mode and no loop (a stopped or failed turn; data-orb-frozen). Idempotent: the
// same mode and frozen flag is a no-op.
function orbSetState(canvas, mode, { frozen = false } = {}) {
  if (!canvas) return;
  const next = ORB_PRESETS[mode] ? mode : null;
  const still = !!next && !!frozen;
  let st = orbStates.get(canvas);
  if (!st) { st = { canvas, mode: null, frozen: false, ctx: undefined, color: '#888', dpr: 1, raf: null, frames: 0 }; orbStates.set(canvas, st); }
  if (st.mode === next && st.frozen === still && (next || canvas.classList.contains('hidden'))) return;
  orbStop(st);
  st.mode = next;
  st.frozen = still;
  canvas.classList.toggle('hidden', !next);
  if (next) canvas.setAttribute('data-orb', next); else canvas.removeAttribute('data-orb');
  if (still) canvas.setAttribute('data-orb-frozen', 'true'); else canvas.removeAttribute('data-orb-frozen');
  if (!next || !orbContext(st)) return;
  const dpr = Math.min(ORB_DPR_MAX, (typeof devicePixelRatio !== 'undefined' && devicePixelRatio) || 1);
  const px = Math.round(ORB_SIZE * dpr);
  if (canvas.width !== px) canvas.width = px;
  if (canvas.height !== px) canvas.height = px;
  st.dpr = dpr;
  orbReadColor(st);
  if (still) { orbDraw(st, ORB_STATIC_T); return; } // a frozen state: one static frame, no loop
  orbStart(st);
}
