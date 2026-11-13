'use strict';
// src/update-check.js: the version comparison, the throttle (a day after a success, an hour after a failure, the attempt
// stored before its request), the silent failures, the stored version marking the panel at its start, the storage
// change reaching an open panel, and store installs (update_url) running nothing. The panels are the sandbox's (no
// manifest at load, so the check is off there; a test turns it on and calls startUpdateCheck, the panel's start); the
// last tests run the module's own top-level start in a context of its own. No test reaches the network: fetch is the
// sandbox's stub. The Settings line and the gear's aria-label are in test/dom/update-check.test.js.
const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const { load, deq, fileText, waitFor } = require('./lib/sandbox');
const { sharedStorage, webLocks, tick } = require('./lib/shared-storage');

const KEY = 'muninUpdateCheck';
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const json = (obj, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => obj, headers: { get: () => '' } });

// A sandbox panel turned into an unpacked install of `installed`. p.answer(url, init) answers the requests (default:
// the repository's manifest with p.latest); p.fetches logs them with the stored record at the moment of the request.
// store: a sharedStorage() for several panels (with webLocks: locks), else the panel's own storage.
async function panel({ installed = '1.1.3', latest = '1.1.4', store = null, locks = null, record, consts = null } = {}) {
  const env = await load(consts ? { consts } : {});
  const p = { env, T: env.T, latest, fetches: [], console: [] };
  p.items = store ? store.items : env.storage;
  if (store) store.attach(env);
  if (locks) env.ctx.navigator.locks = locks;
  if (record !== undefined) p.items[KEY] = record;
  env.chrome.runtime.getManifest = () => ({ version: installed });
  p.answer = async () => json({ manifest_version: 3, version: p.latest });
  env.ctx.fetch = async (url, init) => {
    p.fetches.push({ url, init, stored: JSON.parse(JSON.stringify(p.items[KEY] || null)) });
    return p.answer(url, init);
  };
  const log = (...a) => p.console.push(a.join(' '));
  env.ctx.console = { log, info: log, warn: log, error: log, debug: log };
  p.dot = () => env.document.getElementById('settingsBtn').classList.contains('update-dot');
  // what the chat holds besides its state at load (the empty-chat hint): a check adds nothing
  const atLoad = env.T.el.chat.children.slice();
  p.chat = () => env.T.el.chat.children.filter((c) => !atLoad.includes(c)).length;
  return p;
}

test('compareVersions: numeric per dot-separated part, missing parts count 0; anything else is not a version', async () => {
  const { T } = await load();
  const cmp = (a, b) => T.compareVersions(a, b);
  deq([cmp('1.1.10', '1.1.9'), cmp('1.1.9', '1.1.10'), cmp('1.1.3', '1.1.3')], [1, -1, 0]);
  deq([cmp('1.2', '1.2.0'), cmp('1.2.0.0', '1.2'), cmp('2', '1.9.9.9'), cmp('1.10', '1.9.99'), cmp('01.2', '1.2'), cmp('0.0.0.1', '0')], [0, 0, 1, 1, 0, 1]);
  for (const junk of ['', 'v1.2', '1.2.3.4.5', '1..2', '1.2.', '.1', ' 1.2', '1.2 ', '1.2-beta', '1.2\n', '１.2', '12345678901', '1e3', '0x10', 5, 1.2, null, undefined, {}, ['1.2']]) {
    assert.strictEqual(cmp(junk, '1.2'), null, JSON.stringify(junk));
    assert.strictEqual(cmp('1.2', junk), null, JSON.stringify(junk));
    assert.strictEqual(T.isNewerVersion(junk, '1.2'), false, JSON.stringify(junk));
  }
  // only a strictly newer remote version counts
  deq([T.isNewerVersion('1.1.4', '1.1.3'), T.isNewerVersion('1.1.10', '1.1.9'), T.isNewerVersion('1.2', '1.1.99')], [true, true, true]);
  deq([T.isNewerVersion('1.1.3', '1.1.3'), T.isNewerVersion('1.2.0', '1.2'), T.isNewerVersion('1.1.2', '1.1.3'), T.isNewerVersion('1.1.4', 'dev')], [false, false, false, false]);
});

test('updateCheckDue: a day after a success, an hour after a failure; no record, a bad one or one from the future is due', async () => {
  const { T } = await load();
  const now = Date.UTC(2026, 10, 13, 12);
  const due = (rec) => T.updateCheckDue(rec, now);
  deq([due({}), due(null), due({ at: 'x', ok: true }), due({ at: now + 60000, ok: true })], [true, true, true, true]);
  deq([due({ at: now - DAY + 1, ok: true }), due({ at: now - DAY, ok: true }), due({ at: now, ok: true })], [false, true, false]);
  deq([due({ at: now - HOUR + 1, ok: false }), due({ at: now - HOUR, ok: false }), due({ at: now - 2 * HOUR })], [false, true, true]);
});

test('a due check: one plain GET of the manifest, the attempt stored before it, the version after it; the gear is marked', async () => {
  const p = await panel();
  assert.strictEqual(p.dot(), false);
  const t0 = Date.now();
  const rec = await p.T.startUpdateCheck();
  assert.strictEqual(p.fetches.length, 1);
  const { url, init, stored } = p.fetches[0];
  assert.strictEqual(url, 'https://raw.githubusercontent.com/Olecon/gdocs-munin-assistant/main/manifest.json');
  assert.strictEqual(url, p.T.UPDATE_MANIFEST_URL);
  // nothing but the URL: no headers, no body, no credentials, no cache
  deq(Object.keys(init).sort(), ['cache', 'credentials', 'method', 'signal']);
  deq([init.method, init.credentials, init.cache], ['GET', 'omit', 'no-store']);
  // the attempt was stored before the request started
  assert.ok(stored && stored.at >= t0 && stored.at <= Date.now());
  deq([stored.ok, stored.version], [false, '']);
  deq(p.items[KEY], { at: stored.at, ok: true, version: '1.1.4' });
  deq(rec, p.items[KEY]);
  assert.strictEqual(p.dot(), true);
  deq([p.console, p.chat()], [[], 0]);
  // once per panel: a second start asks nothing
  await p.T.startUpdateCheck();
  assert.strictEqual(p.fetches.length, 1);
});

test('not due: no request; the stored newer version marks the panel at its start, before any request', async () => {
  const p = await panel({ record: { at: Date.now() - DAY + HOUR, ok: true, version: '1.1.4' } });
  await p.T.startUpdateCheck();
  deq([p.fetches.length, p.dot()], [0, true]);
  // a due check: the mark is there while the request is still on its way
  const q = await panel({ record: { at: Date.now() - 2 * DAY, ok: true, version: '1.1.4' } });
  let answer;
  q.answer = () => new Promise((r) => { answer = r; });
  const started = q.T.startUpdateCheck();
  await waitFor(() => q.fetches.length === 1, 'the request');
  assert.strictEqual(q.dot(), true, 'marked from the stored version before the answer');
  answer(json({ version: '1.1.3' })); // GitHub now has the installed version (a release taken back): the mark goes
  await started;
  deq([q.dot(), q.items[KEY].version, q.items[KEY].ok], [false, '1.1.3', true]);
});

test('the throttle: a success is not asked again within a day, a failure within an hour', async () => {
  const cases = [
    [{ at: Date.now() - DAY + 60000, ok: true, version: '1.1.4' }, 0],
    [{ at: Date.now() - DAY - 1, ok: true, version: '1.1.4' }, 1],
    [{ at: Date.now() - HOUR + 60000, ok: false, version: '1.1.4' }, 0],
    [{ at: Date.now() - HOUR - 1, ok: false, version: '1.1.4' }, 1],
  ];
  for (const [record, requests] of cases) {
    const p = await panel({ record });
    await p.T.startUpdateCheck();
    assert.strictEqual(p.fetches.length, requests, JSON.stringify(record));
    assert.strictEqual(p.dot(), true);
  }
});

test('every failure keeps the last known version, stores ok false with the attempt time and says nothing anywhere', async () => {
  const shapes = {
    'no network': async () => { throw new TypeError('Failed to fetch'); },
    'HTTP 404': async () => json({ message: 'Not Found' }, 404),
    'HTTP 500': async () => json(null, 500),
    'HTTP 204': async () => json(null, 204),
    'no response': async () => undefined,
    'bad JSON': async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } }),
    'version a number': async () => json({ version: 2 }),
    'version with a prefix': async () => json({ version: 'v1.2.0' }),
    'five parts': async () => json({ version: '1.2.3.4.5' }),
    'markup': async () => json({ version: '<img src=x onerror=alert(1)>' }),
    'no version': async () => json({ name: 'x' }),
    'null': async () => json(null),
    'an array': async () => json(['1.2']),
    'a string': async () => json('1.2.0'),
  };
  const unhandled = [];
  const onRejection = (e) => unhandled.push(e);
  process.on('unhandledRejection', onRejection);
  try {
    for (const [name, answer] of Object.entries(shapes)) {
      const p = await panel({ record: { at: Date.now() - 2 * DAY, ok: true, version: '1.1.4' } });
      p.answer = answer;
      const t0 = Date.now();
      await p.T.startUpdateCheck();
      assert.strictEqual(p.fetches.length, 1, name);
      const rec = p.items[KEY];
      deq([rec.ok, rec.version], [false, '1.1.4'], name);
      assert.ok(rec.at >= t0, name);
      assert.strictEqual(p.dot(), true, `${name}: the last known version still marks the gear`);
      deq([p.console, p.chat()], [[], 0], name);
    }
    // the reasons only the self-test row shows
    const p = await panel();
    const reasons = [];
    for (const name of ['no network', 'HTTP 404', 'no response', 'bad JSON', 'five parts']) {
      p.answer = shapes[name];
      reasons.push((await p.T.fetchLatestVersion()).error);
    }
    deq(reasons, ['Failed to fetch', 'HTTP 404', 'no response', 'the answer is not JSON', 'the answer has no version number']);
    assert.ok(!(KEY in p.items), 'fetchLatestVersion alone stores nothing');
  } finally {
    process.off('unhandledRejection', onRejection);
  }
  deq(unhandled, []);
});

test('no answer in time: the request is aborted, the attempt counts as failed and the next one is due an hour later', async () => {
  const p = await panel({ record: { at: Date.now() - 2 * DAY, ok: true, version: '1.1.4' }, consts: { UPDATE_CHECK_TIMEOUT_MS: 40 } });
  // like fetch, the request ends with an AbortError when its signal fires
  p.answer = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })));
  });
  const t0 = Date.now();
  await p.T.startUpdateCheck();
  assert.ok(Date.now() - t0 >= 35);
  deq([p.items[KEY].ok, p.items[KEY].version, p.dot(), p.console], [false, '1.1.4', true, []]);
  deq(await p.T.fetchLatestVersion(), { error: 'no answer within 0.04 s' });
  deq([p.T.updateCheckDue(p.items[KEY], p.items[KEY].at + HOUR - 1), p.T.updateCheckDue(p.items[KEY], p.items[KEY].at + HOUR)], [false, true]);
});

test('two panels opening together ask GitHub once; the other panel is marked by the storage change', async () => {
  const store = sharedStorage();
  const locks = webLocks();
  const a = await panel({ store, locks });
  const b = await panel({ store, locks });
  let answer;
  a.answer = () => new Promise((r) => { answer = r; });
  b.answer = a.answer;
  const both = Promise.all([a.T.startUpdateCheck(), b.T.startUpdateCheck()]);
  await waitFor(() => a.fetches.length + b.fetches.length === 1, 'one request');
  await tick(20);
  assert.strictEqual(a.fetches.length + b.fetches.length, 1, 'the second panel saw the attempt and did not ask');
  assert.ok(locks.log.filter((n) => n === 'munin:update-check').length === 2);
  answer(json({ version: '1.1.4' }));
  await both;
  await waitFor(() => a.dot() && b.dot(), 'both gears marked');
  deq(store.items[KEY].version, '1.1.4');
  // a later record from elsewhere (the self-test row of a third panel) reaches both open panels
  await store.local.set({ [KEY]: { at: Date.now(), ok: true, version: '1.1.3' } });
  await waitFor(() => !a.dot() && !b.dot(), 'both marks gone: GitHub has the installed version');
  await store.local.set({ [KEY]: { at: Date.now(), ok: true, version: '1.2.0' } });
  await waitFor(() => a.dot() && b.dot(), 'marked again');
  await store.local.remove(KEY);
  await waitFor(() => !a.dot() && !b.dot(), 'a removed record clears the marks');
  deq([a.console, b.console], [[], []]);
});

test('after the update the installed version catches up: the stored version marks nothing', async () => {
  const p = await panel({ installed: '1.1.4', record: { at: Date.now(), ok: true, version: '1.1.4' } });
  await p.T.startUpdateCheck();
  deq([p.fetches.length, p.dot()], [0, false]);
  // the owner's own install, ahead of GitHub
  const q = await panel({ installed: '1.2.0', latest: '1.1.4' });
  await q.T.startUpdateCheck();
  deq([q.fetches.length, q.dot(), q.items[KEY].version], [1, false, '1.1.4']);
});

test('a store install (update_url) or no manifest: nothing runs, nothing is read, asked or watched', async () => {
  for (const manifest of [{ version: '1.1.3', update_url: 'https://clients2.google.com/service/update2/crx' }, null]) {
    const p = await panel({ record: { at: 0, ok: true, version: '9.0' } });
    p.env.chrome.runtime.getManifest = manifest ? () => manifest : () => { throw new Error('no runtime'); };
    const reads = [];
    const get = p.env.chrome.storage.local.get;
    p.env.chrome.storage.local.get = (k) => { reads.push(k); return get(k); };
    let watched = 0;
    p.env.chrome.storage.onChanged = { addListener: () => { watched++; } };
    assert.strictEqual(await p.T.startUpdateCheck(), null);
    assert.strictEqual(p.T.updateCheckOn(), false);
    deq([p.fetches.length, reads.filter((k) => k === KEY || (Array.isArray(k) && k.includes(KEY))).length, watched, p.dot()], [0, 0, 0, false]);
    deq(p.items[KEY], { at: 0, ok: true, version: '9.0' });
  }
});

// ---- The module's own start, in a context of its own ---------------------------------------------------------
// constants.js and update-check.js only, with stand-ins for what they take from other modules (renderVersion of
// settings.js, withLock of chats.js): the top-level startUpdateCheck() runs as it does in the panel.
async function bare({ manifest = { version: '1.1.3' }, record, fetch, getFails = false } = {}) {
  const items = record === undefined ? {} : { [KEY]: record };
  const calls = [];
  const listeners = [];
  const classes = new Set();
  const attrs = {};
  const gear = { classList: { toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); } }, setAttribute: (k, v) => { attrs[k] = v; } };
  const ctx = {
    console: { log: (...a) => calls.push(['console', ...a]), warn: (...a) => calls.push(['console', ...a]), error: (...a) => calls.push(['console', ...a]) },
    location: { hash: '' }, setTimeout, clearTimeout, AbortController,
    document: { getElementById: (id) => (id === 'settingsBtn' ? gear : null) },
    chrome: {
      runtime: { getManifest: () => manifest },
      storage: {
        local: {
          get: async (k) => { calls.push(['get', k]); if (getFails) throw new Error('storage gone'); return k in items ? { [k]: JSON.parse(JSON.stringify(items[k])) } : {}; },
          set: async (o) => { calls.push(['set', JSON.parse(JSON.stringify(o))]); Object.assign(items, JSON.parse(JSON.stringify(o))); },
        },
        onChanged: { addListener: (fn) => listeners.push(fn) },
      },
    },
    renderVersion: (v) => calls.push(['renderVersion', v]),
    withLock: (name, fn) => fn(),
    fetch: async (url, init) => { calls.push(['fetch', url]); return fetch ? fetch(url, init) : json({ version: '1.1.4' }); },
  };
  vm.createContext(ctx);
  for (const f of ['src/constants.js', 'src/update-check.js']) vm.runInContext(fileText(f), ctx, { filename: f });
  return { ctx, calls, items, listeners, classes, attrs };
}

test('the panel start itself: the stored newer version is shown before any request; a due check stores the attempt first', async () => {
  // not due: shown at once, no request
  let m = await bare({ record: { at: Date.now() - HOUR, ok: true, version: '1.1.4' } });
  await tick(10);
  deq(m.calls.map((c) => c[0]), ['get', 'renderVersion', 'get']);
  deq(m.calls[1], ['renderVersion', '1.1.4']);
  deq([[...m.classes], m.attrs['aria-label']], [['update-dot'], 'Settings (update available)']);
  assert.strictEqual(m.listeners.length, 1);
  // a storage change from another panel: GitHub has the installed version, the marks go
  m.listeners[0]({ [KEY]: { newValue: { at: Date.now(), ok: true, version: '1.1.3' } } }, 'local');
  m.listeners[0]({ other: { newValue: 1 } }, 'local');
  m.listeners[0]({ [KEY]: { newValue: { version: '9.9' } } }, 'sync'); // not the local area
  deq([[...m.classes], m.attrs['aria-label'], m.calls.at(-1)], [[], 'Settings', ['renderVersion', '']]);
  // due: the stored version is shown, then the attempt is stored, then the request, then the result
  m = await bare({ record: { at: Date.now() - 2 * DAY, ok: true, version: '1.1.4' }, fetch: async () => json({ version: '1.2.0' }) });
  await tick(10);
  deq(m.calls.map((c) => (c[0] === 'set' ? `set ok=${c[1][KEY].ok} ${c[1][KEY].version}` : c[0] === 'renderVersion' ? `render ${c[1]}` : c[0])),
    ['get', 'render 1.1.4', 'get', 'set ok=false 1.1.4', 'fetch', 'set ok=true 1.2.0', 'render 1.2.0']);
  deq(m.calls.filter((c) => c[0] === 'console'), []);
});

test('the panel start itself: off for a store install; a failing storage never reaches the page', async () => {
  const m = await bare({ manifest: { version: '1.1.3', update_url: 'https://clients2.google.com/service/update2/crx' }, record: { at: 0, ok: true, version: '2.0' } });
  await tick(10);
  deq([m.calls, m.listeners.length, [...m.classes]], [[], 0, []]);
  const unhandled = [];
  const onRejection = (e) => unhandled.push(e);
  process.on('unhandledRejection', onRejection);
  try {
    const f = await bare({ getFails: true });
    await tick(10);
    assert.strictEqual(await vm.runInContext('startUpdateCheck()', f.ctx), null); // already started: the same quiet answer
    deq(f.calls.map((c) => c[0]), ['get']);
  } finally {
    process.off('unhandledRejection', onRejection);
  }
  deq(unhandled, []);
});
