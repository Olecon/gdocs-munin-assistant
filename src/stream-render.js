'use strict';
// Module stream-render.js: the render coordinator of a streaming answer (createRenderCoordinator). The
// providers call their hooks once per SSE chunk; the live bubble is repainted on an animation frame with
// only the latest state, at most once per adaptive interval, so that a long answer with slow Markdown
// rendering does not repaint more often than the panel can keep up with.
/* global STREAM_RENDER_MAX_MS, STREAM_RENDER_MIN_MS */
/* exported createRenderCoordinator */

// Milliseconds for measuring renders (the test sandboxes may have no performance object).
function streamRenderNow() {
  return typeof performance !== 'undefined' && performance && typeof performance.now === 'function' ? performance.now() : Date.now();
}

// Runs fn on an animation frame after delayMs (setTimeout without requestAnimationFrame, as in the vm sandbox).
// Returns a function that drops whatever is still pending (the delay timer or the frame).
function streamRenderFrame(fn, delayMs) {
  const raf = typeof requestAnimationFrame === 'function';
  let timer = null;
  let frameId = null;
  const frame = () => {
    timer = null;
    if (raf) frameId = requestAnimationFrame(fn);
    else timer = setTimeout(fn, 16);
  };
  if (delayMs > 0) timer = setTimeout(frame, delayMs);
  else frame();
  return () => {
    if (timer != null) clearTimeout(timer);
    if (frameId != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameId);
    timer = frameId = null;
  };
}

// renderFn(snapshot) paints a snapshot of the streaming state. Returns:
//   update(snapshot): keeps only this snapshot (an unrendered earlier one is dropped) and schedules a render
//     no sooner than interval() after the previous one started;
//   flush(): renders a pending snapshot now (true) or does nothing (false; idempotent);
//   cancel(): drops the pending snapshot and the scheduled tick (its timer or frame, when the scheduler returns a
//     canceller; a tick that still fires does nothing: generation counter);
//   interval(): the current minimum interval, clamp(2 × the last render's duration, minMs..maxMs).
// A renderFn that throws still consumes its snapshot (one console.warn per coordinator), so the stream goes on.
// opts (tests): schedule(fn, delayMs) (default streamRenderFrame; may return a canceller), now() (default streamRenderNow), minMs, maxMs.
function createRenderCoordinator(renderFn, opts = {}) {
  const schedule = opts.schedule || streamRenderFrame;
  const now = opts.now || streamRenderNow;
  const minMs = Number.isFinite(opts.minMs) ? opts.minMs : STREAM_RENDER_MIN_MS;
  const maxMs = Number.isFinite(opts.maxMs) ? opts.maxMs : STREAM_RENDER_MAX_MS;
  let generation = 0;
  let snapshot = null;
  let dirty = false;
  let armed = false; // a scheduled tick of this generation is on its way
  let unschedule = null; // drops that tick's timer or frame (cancel)
  let lastStart = -Infinity;
  let minInterval = minMs;
  let warned = false;

  const render = () => {
    const s = snapshot;
    snapshot = null;
    dirty = false;
    const t0 = now();
    lastStart = t0;
    try {
      renderFn(s);
    } catch (e) {
      if (!warned) { warned = true; console.warn('Munin Assistant: a streaming render failed:', e); }
    }
    minInterval = Math.min(maxMs, Math.max(minMs, 2 * (now() - t0)));
  };
  const arm = () => {
    armed = true;
    const gen = generation;
    const c = schedule(() => tick(gen), Math.max(0, lastStart + minInterval - now()));
    unschedule = typeof c === 'function' ? c : null;
  };
  const tick = (gen) => {
    if (gen !== generation) return; // cancelled meanwhile (Stop, an error, the end of the reply)
    armed = false;
    unschedule = null;
    if (!dirty) return; // flushed meanwhile
    if (now() - lastStart < minInterval) { arm(); return; } // a timer that fired early, or a flush just ran
    render();
  };

  return {
    update(s) {
      snapshot = s;
      dirty = true;
      if (!armed) arm();
    },
    flush() {
      if (!dirty) return false;
      render();
      return true;
    },
    cancel() {
      generation++;
      if (unschedule) unschedule(); // no timer or frame is left behind (up to maxMs of no-op ticks otherwise)
      unschedule = null;
      armed = false;
      dirty = false;
      snapshot = null;
    },
    interval: () => minInterval,
  };
}
