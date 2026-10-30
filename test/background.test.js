'use strict';
// background.js (the service worker): the action is enabled only on Docs document tabs (install/startup,
// onUpdated, onActivated), the toolbar click sends TOGGLE_PANEL and injects content.js when no content
// script answers, an unpacked install/update re-injects content.js into open Docs tabs, GET_TAB_ID.
const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./lib/sandbox');

const SRC = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
const DOC = 'https://docs.google.com/document/d/DOC123/edit';
const tick = () => new Promise((r) => setTimeout(r, 0));

// A fresh worker with stub chrome.* APIs. Returns { chrome, on (the registered listeners), log, warns, tabs }.
function loadWorker() {
  const on = {};
  const listen = (name) => ({ addListener: (fn) => { on[name] = fn; } });
  const log = [];
  const warns = [];
  const tabs = new Map();
  const chrome = {
    action: {
      enable: async (id) => { log.push(['enable', id]); if (id === 666) throw new Error('No tab with id: 666'); },
      disable: async (id) => { log.push(['disable', id]); },
      onClicked: listen('clicked'),
    },
    tabs: {
      query: async () => [...tabs.values()],
      get: async (id) => { if (!tabs.has(id)) throw new Error('No tab with id: ' + id); return tabs.get(id); },
      sendMessage: async (id, msg) => { log.push(['send', id, msg.type]); return { ok: true }; },
      onUpdated: listen('updated'), onActivated: listen('activated'),
    },
    scripting: { executeScript: async (opts) => { log.push(['inject', opts.target.tabId, opts.files.join(',')]); } },
    runtime: { getManifest: () => ({ version: '1.0' }), onInstalled: listen('installed'), onStartup: listen('startup'), onMessage: listen('message') },
  };
  const ctx = { chrome, console: { warn: (...a) => warns.push(a.map(String).join(' ')), log() {}, error() {} } };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: 'background.js' });
  return { chrome, on, log, warns, tabs };
}

test('every listener is registered at load', () => {
  const w = loadWorker();
  assert.deepStrictEqual(Object.keys(w.on).sort(), ['activated', 'clicked', 'installed', 'message', 'startup', 'updated']);
});

test('install / startup: the action is enabled on Docs documents and disabled elsewhere', async () => {
  for (const ev of ['installed', 'startup']) {
    const w = loadWorker();
    w.tabs.set(1, { id: 1, url: DOC });
    w.tabs.set(2, { id: 2, url: 'https://docs.google.com/spreadsheets/d/X/edit' });
    w.tabs.set(3, { id: 3, url: 'https://example.com/' });
    w.tabs.set(4, { id: 4 }); // no URL permission (chrome:// page)
    await w.on[ev]();
    assert.deepStrictEqual(w.log.sort(), [['disable', 2], ['disable', 3], ['disable', 4], ['enable', 1]], ev);
  }
  const w = loadWorker();
  w.chrome.tabs.query = async () => { throw new Error('boom'); };
  await w.on.installed();
  assert.ok(w.warns[0].startsWith('tabs init failed'));
});

test('onUpdated: on a URL change and on loading / complete; other updates are ignored', async () => {
  const w = loadWorker();
  w.on.updated(5, { url: DOC }, { id: 5, url: DOC });
  w.on.updated(6, { status: 'loading' }, { id: 6, url: 'https://example.com/' });
  w.on.updated(5, { status: 'complete' }, { id: 5, url: DOC });
  w.on.updated(5, { title: 'Renamed' }, { id: 5, url: DOC }); // ignored
  w.on.updated(5, { audible: true }, { id: 5, url: DOC }); // ignored
  w.on.updated(-1, { status: 'complete' }, { id: -1, url: DOC }); // no real tab
  w.on.updated(666, { status: 'complete' }, { id: 666, url: DOC }); // closed meanwhile: no error
  await tick();
  assert.deepStrictEqual(w.log, [['enable', 5], ['disable', 6], ['enable', 5], ['enable', 666]]);
  // navigating a Docs tab elsewhere disables it again
  w.log.length = 0;
  w.on.updated(5, { url: 'https://www.google.com/' }, { id: 5, url: 'https://www.google.com/' });
  await tick();
  assert.deepStrictEqual(w.log, [['disable', 5]]);
});

test('onActivated: looks the tab up; a vanished tab is ignored', async () => {
  const w = loadWorker();
  w.tabs.set(8, { id: 8, url: DOC });
  w.tabs.set(9, { id: 9, url: 'https://mail.google.com/' });
  await w.on.activated({ tabId: 8, windowId: 1 });
  await w.on.activated({ tabId: 9, windowId: 1 });
  await w.on.activated({ tabId: 10, windowId: 1 });
  await tick();
  assert.deepStrictEqual(w.log, [['enable', 8], ['disable', 9]]);
});

test('toolbar click: TOGGLE_PANEL to the content script; injected first when nothing answers', async () => {
  const w = loadWorker();
  await w.on.clicked({ id: 3, url: DOC });
  assert.deepStrictEqual(w.log, [['send', 3, 'TOGGLE_PANEL']]);
  // not a document tab, or no tab: nothing
  w.log.length = 0;
  await w.on.clicked({ id: 4, url: 'https://example.com/' });
  await w.on.clicked(undefined);
  await w.on.clicked({ url: DOC });
  assert.deepStrictEqual(w.log, []);
  // the tab was open before the extension was installed: inject content.js, then toggle
  let calls = 0;
  w.chrome.tabs.sendMessage = async (id, msg) => {
    w.log.push(['send', id, msg.type]);
    if (++calls === 1) throw new Error('Could not establish connection. Receiving end does not exist.');
    return { ok: true, open: true };
  };
  await w.on.clicked({ id: 3, url: DOC });
  assert.deepStrictEqual(w.log, [['send', 3, 'TOGGLE_PANEL'], ['inject', 3, 'content.js'], ['send', 3, 'TOGGLE_PANEL']]);
  // injection impossible (e.g. the page is not ready): a warning, no exception
  w.log.length = 0;
  w.chrome.tabs.sendMessage = async () => { throw new Error('Receiving end does not exist.'); };
  w.chrome.scripting.executeScript = async () => { throw new Error('Cannot access contents of the page'); };
  await w.on.clicked({ id: 3, url: DOC });
  assert.ok(w.warns.some((s) => s.startsWith('Could not open the Munin panel')));
});

test('GET_TAB_ID answers with the sender tab; other messages get no answer', () => {
  const w = loadWorker();
  const answers = [];
  assert.strictEqual(w.on.message({ type: 'GET_TAB_ID' }, { tab: { id: 42 } }, (r) => answers.push(r)), false);
  w.on.message({ type: 'GET_TAB_ID' }, {}, (r) => answers.push(r));
  w.on.message({ type: 'OTHER' }, { tab: { id: 1 } }, (r) => answers.push(r));
  w.on.message(null, {}, (r) => answers.push(r));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(answers)), [{ tabId: 42 }, { tabId: null }]);
});

test('onInstalled (install / update of an unpacked build): content.js is injected into open Docs tabs', async () => {
  for (const reason of ['update', 'install']) {
    const w = loadWorker();
    w.tabs.set(1, { id: 1, url: DOC });
    w.tabs.set(2, { id: 2, url: 'https://docs.google.com/spreadsheets/d/X/edit' });
    w.tabs.set(3, { id: 3, url: 'https://docs.google.com/document/d/OTHER/edit' });
    await w.on.installed({ reason, previousVersion: '1.0' });
    assert.deepStrictEqual(w.log.filter((e) => e[0] === 'inject'), [['inject', 1, 'content.js'], ['inject', 3, 'content.js']], reason);
  }
  // a tab that refuses the injection (discarded, loading) does not stop the others and logs nothing
  const w = loadWorker();
  w.tabs.set(1, { id: 1, url: DOC });
  w.tabs.set(3, { id: 3, url: DOC });
  w.chrome.scripting.executeScript = async (opts) => {
    if (opts.target.tabId === 1) throw new Error('Frame with ID 0 is showing error page');
    w.log.push(['inject', opts.target.tabId]);
  };
  await w.on.installed({ reason: 'update' });
  assert.deepStrictEqual(w.log.filter((e) => e[0] === 'inject'), [['inject', 3]]);
  assert.deepStrictEqual(w.warns, []);
});

test('onInstalled: no injection on a Chrome update, nor for a store build (update_url)', async () => {
  let w = loadWorker();
  w.tabs.set(1, { id: 1, url: DOC });
  await w.on.installed({ reason: 'chrome_update' });
  assert.ok(!w.log.some((e) => e[0] === 'inject'));
  w = loadWorker();
  w.tabs.set(1, { id: 1, url: DOC });
  w.chrome.runtime.getManifest = () => ({ version: '1.0', update_url: 'https://clients2.google.com/service/update2/crx' });
  await w.on.installed({ reason: 'update' });
  assert.ok(!w.log.some((e) => e[0] === 'inject'));
  assert.deepStrictEqual(w.log.sort(), [['enable', 1]]); // the action state is still set
});
