'use strict';
// Several panels ("tabs") on one chrome.storage.local: sharedStorage() keeps one item map; attach(env)
// gives a loaded panel that storage plus chrome.storage.onChanged. Like Chrome, values are copied on
// set and get, every set / remove fires onChanged in every attached panel (the writer included),
// asynchronously and in write order, and get(null) / getKeys() list everything. webLocks() is a
// navigator.locks stand-in shared by the panels it is given to (exclusive, FIFO per name, with
// ifAvailable and signal); log holds the requested lock names, held(name) tells whether a lock is held.
function sharedStorage() {
  const items = {};
  const panels = [];
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const emit = (changes) => {
    for (const p of panels) {
      const copy = clone(changes);
      setTimeout(() => { if (!p.detached) p.listeners.forEach((fn) => fn(copy, 'local')); }, 0);
    }
  };
  const local = {
    get: async (keys) => {
      if (keys == null) return clone(items);
      const out = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) if (k in items) out[k] = clone(items[k]);
      return out;
    },
    getKeys: async () => Object.keys(items),
    set: async (obj) => {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) { changes[k] = { oldValue: clone(items[k]), newValue: clone(v) }; items[k] = clone(v); }
      emit(changes);
    },
    remove: async (keys) => {
      const changes = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) if (k in items) { changes[k] = { oldValue: items[k] }; delete items[k]; }
      if (Object.keys(changes).length) emit(changes);
    },
  };
  const attach = (env) => {
    const panel = { listeners: [], detached: false };
    panels.push(panel);
    env.chrome.storage.local = local;
    env.chrome.storage.onChanged = { addListener: (fn) => panel.listeners.push(fn) };
    return panel;
  };
  return { items, local, attach };
}

function webLocks() {
  const names = new Map(); // name -> { held, queue }
  const log = [];
  const slot = (name) => { if (!names.has(name)) names.set(name, { held: false, queue: [] }); return names.get(name); };
  const abortError = () => Object.assign(new Error('The request was aborted.'), { name: 'AbortError' });
  const next = (q) => { if (!q.held && q.queue.length) q.queue.shift().run(); };
  return {
    log,
    // Like navigator.locks.request: cb(lock) runs once the lock is free and the lock is held until the
    // promise cb returns settles. { ifAvailable: true } calls cb(null) at once when the lock is taken;
    // { signal } rejects with an AbortError (and leaves the queue) when it fires before the grant.
    request(name, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      log.push(name);
      const q = slot(name);
      if (opts.ifAvailable && (q.held || q.queue.length)) return Promise.resolve().then(() => cb(null));
      if (opts.signal && opts.signal.aborted) return Promise.reject(abortError());
      return new Promise((resolve, reject) => {
        const entry = {
          run() {
            q.held = true;
            Promise.resolve().then(() => cb({ name, mode: 'exclusive' })).then(resolve, reject)
              .finally(() => { q.held = false; next(q); });
          },
        };
        q.queue.push(entry);
        if (opts.signal) {
          opts.signal.addEventListener('abort', () => {
            const i = q.queue.indexOf(entry);
            if (i >= 0) { q.queue.splice(i, 1); reject(abortError()); }
          }, { once: true });
        }
        next(q);
      });
    },
    held: (name) => !!(names.get(name) && names.get(name).held),
    // Like navigator.locks.query: the held locks and the waiting requests.
    query: async () => ({
      held: [...names].filter(([, q]) => q.held).map(([name]) => ({ name, mode: 'exclusive' })),
      pending: [...names].flatMap(([name, q]) => q.queue.map(() => ({ name, mode: 'exclusive' }))),
    }),
  };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

module.exports = { sharedStorage, webLocks, tick };
