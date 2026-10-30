'use strict';
// The real-DOM test bench (jsdom). load() parses sidepanel.html, installs stub chrome.* / fetch /
// matchMedia / clipboard like sandbox.js, runs the src/ scripts in HTML order inside the window (one
// global scope, like classic scripts) and returns handles to the panel. loadContent() does the same for
// content.js on a fake Google Docs page. Helpers dispatch real DOM events (click, key, typeInto, pointer).
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

// Console output of the page goes to the test's console; jsdom's "not implemented" notices (window.focus
// and the like) are dropped, uncaught exceptions in the page are kept.
const quietConsole = () => new VirtualConsole().forwardTo(console, { jsdomErrors: ['unhandled-exception'] });
const { ROOT, SCRIPTS, TEST_CLIENT_ID, panelSource } = require('./sandbox');

const HTML = fs.readFileSync(path.join(ROOT, 'sidepanel.html'), 'utf8');
const sources = new Map(); // file -> source text (read once per process)
const source = (f) => { if (!sources.has(f)) sources.set(f, fs.readFileSync(path.join(ROOT, f), 'utf8')); return sources.get(f); };

// chrome.storage.local over a plain object, plus session storage, tabs, runtime and scripting stubs
// (the same surface as sandbox.js). Tests replace single methods as they need.
function makeChrome(storage, session = {}) {
  const keyList = (keys) => (keys == null ? Object.keys(storage) : Array.isArray(keys) ? keys : typeof keys === 'object' ? Object.keys(keys) : [keys]);
  const listeners = [];
  return {
    storage: {
      local: {
        get: async (keys) => { const out = {}; keyList(keys).forEach((k) => { if (k in storage) out[k] = JSON.parse(JSON.stringify(storage[k])); }); return out; },
        set: async (items) => { Object.assign(storage, JSON.parse(JSON.stringify(items))); },
        remove: async (keys) => { (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete storage[k]); },
      },
      session: {
        get: async (keys) => { const out = {}; (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in session) out[k] = JSON.parse(JSON.stringify(session[k])); }); return out; },
        set: async (items) => { Object.assign(session, JSON.parse(JSON.stringify(items))); },
        remove: async (keys) => { (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete session[k]); },
      },
    },
    tabs: {
      query: async () => [], get: async () => { throw new Error('no tab'); }, sendMessage: async () => ({}),
      onActivated: { addListener() {} }, onUpdated: { addListener() {} },
    },
    runtime: { id: 'testextid', onMessage: { addListener: (fn) => listeners.push(fn), listeners }, sendMessage: async () => undefined, getURL: (p) => 'chrome-extension://testextid/' + p,
      getManifest: () => ({ version: '9.8.7', update_url: 'test' }) }, // update_url: a store install (no dev reload)
    scripting: { executeScript: async () => {} },
  };
}

// A controllable prefers-color-scheme query: media.set(true|false) changes .matches and fires "change".
function makeMatchMedia(window, light) {
  const queries = [];
  const matchMedia = (q) => {
    const mq = { media: q, matches: !!light, listeners: [], onchange: null,
      addEventListener(t, fn) { if (t === 'change') mq.listeners.push(fn); }, removeEventListener(t, fn) { mq.listeners = mq.listeners.filter((x) => x !== fn); },
      addListener(fn) { mq.listeners.push(fn); }, removeListener(fn) { mq.listeners = mq.listeners.filter((x) => x !== fn); } };
    queries.push(mq);
    return mq;
  };
  const media = {
    queries,
    set(isLight) {
      light = !!isLight;
      for (const mq of queries) {
        mq.matches = light;
        const ev = new window.Event('change');
        ev.matches = light; ev.media = mq.media;
        for (const fn of mq.listeners.slice()) fn(ev);
        if (typeof mq.onchange === 'function') mq.onchange(ev);
      }
    },
  };
  return { matchMedia, media };
}

// Timers that do not keep the test process alive (notices fade after 10 s); close() clears them all.
function installTimers(window) {
  const live = new Set();
  window.setTimeout = (fn, ms, ...a) => {
    const t = setTimeout(() => { live.delete(t); fn(...a); }, ms);
    if (ms >= 500) t.unref();
    live.add(t);
    return t;
  };
  window.clearTimeout = (t) => { live.delete(t); clearTimeout(t); };
  window.requestAnimationFrame = (fn) => window.setTimeout(() => fn(Date.now()), 0);
  window.cancelAnimationFrame = (t) => window.clearTimeout(t);
  return () => { for (const t of live) clearTimeout(t); live.clear(); };
}

// Browser APIs jsdom lacks and the scripts use: pointer capture, clipboard events with a DataTransfer.
function polyfill(window) {
  const E = window.Element.prototype;
  if (typeof E.setPointerCapture !== 'function') { E.setPointerCapture = function () {}; E.releasePointerCapture = function () {}; E.hasPointerCapture = () => false; }
  if (typeof window.DataTransfer !== 'function') {
    window.DataTransfer = class DataTransfer {
      constructor() { this._data = new Map(); }
      setData(type, v) { this._data.set(String(type), String(v)); }
      getData(type) { return this._data.has(String(type)) ? this._data.get(String(type)) : ''; }
      get types() { return [...this._data.keys()]; }
    };
  }
  if (typeof window.ClipboardEvent !== 'function') {
    window.ClipboardEvent = class ClipboardEvent extends window.Event {
      constructor(type, init = {}) { super(type, init); this.clipboardData = init.clipboardData || null; }
    };
  }
}

// Loads the panel. opts: storage (initial chrome.storage.local items), hash ('#tabId=7' for overlay
// mode), light (the system prefers the light theme), settle (ms to let init() finish), googleClientId (the
// built-in OAuth client, as in sandbox.js).
// Returns { dom, window, document, ctx, T, get, run, state, PROVIDERS, el, storage, chrome, media,
// clipboard, close }. ctx is the window (assign ctx.fetch to mock the network); T.<name> evaluates any
// top-level name of the panel scripts; clipboard.writes lists the texts copied.
async function load({ storage: initial = {}, hash = '', light = false, settle = 30, googleClientId = TEST_CLIENT_ID } = {}) {
  const dom = new JSDOM(HTML, { url: 'chrome-extension://testextid/sidepanel.html' + hash, runScripts: 'outside-only', virtualConsole: quietConsole() });
  const { window } = dom;
  const storage = JSON.parse(JSON.stringify(initial));
  const chrome = makeChrome(storage);
  const { matchMedia, media } = makeMatchMedia(window, light);
  const clearTimers = installTimers(window);
  polyfill(window);
  const clipboard = { writes: [], fail: null };
  Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: {
    writeText: async (t) => { if (clipboard.fail) throw new Error(clipboard.fail); clipboard.writes.push(t); },
  } });
  Object.assign(window, { chrome, matchMedia, fetch: async (url) => { throw new Error('unexpected fetch ' + url); } });
  const ctx = dom.getInternalVMContext();
  for (const f of SCRIPTS) new vm.Script(panelSource(f, googleClientId), { filename: f }).runInContext(ctx);
  await new Promise((r) => setTimeout(r, settle)); // let init() settle
  const run = (code) => vm.runInContext(code, ctx);
  const T = new Proxy({}, { get: (_, name) => (typeof name === 'string' && name !== 'then' ? run(name) : undefined) });
  const close = () => { clearTimers(); window.close(); };
  return { dom, window, document: window.document, ctx: window, T, get: run, run, state: run('state'), PROVIDERS: run('PROVIDERS'), el: run('el'),
    storage, chrome, media, clipboard, close };
}

// A minimal fetch Response for the content script's export requests.
// extra: more headers (lower-case names, e.g. { 'retry-after': '3' }).
function textResponse(text, { status = 200, type = 'text/plain; charset=utf-8', disposition = '', extra = {} } = {}) {
  const headers = { 'content-type': type, 'content-disposition': disposition, ...extra };
  return { ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[String(k).toLowerCase()] || null }, text: async () => text };
}

// Loads content.js on a fake Google Docs page: #docs-chrome (the header) and the hidden editor
// iframe (.docs-texteventtarget-iframe, its body contenteditable). opts: url, title, storage, run
// (false: do not inject yet). Returns { dom, window, document, chrome, storage, iframe, editorDoc,
// inject(), send(msg) -> Promise<response>, sent (runtime.sendMessage log), fetchLog, close }.
async function loadContent({ url = 'https://docs.google.com/document/d/DOC123/edit', title = 'My Doc - Google Docs', storage: initial = {}, run = true } = {}) {
  const dom = new JSDOM('<!doctype html><html><head><title></title></head><body><div id="docs-chrome" style="height:100px">Docs header</div>' +
    '<div class="kix-appview-editor"><iframe class="docs-texteventtarget-iframe"></iframe></div></body></html>', { url, runScripts: 'outside-only', virtualConsole: quietConsole() });
  const { window } = dom;
  const { document } = window;
  document.title = title;
  const storage = JSON.parse(JSON.stringify(initial));
  const chrome = makeChrome(storage);
  const sent = [];
  chrome.runtime.sendMessage = async (msg) => { sent.push(JSON.parse(JSON.stringify(msg))); return msg && msg.type === 'GET_TAB_ID' ? { tabId: 7 } : undefined; };
  const clearTimers = installTimers(window);
  polyfill(window);
  const fetchLog = [];
  Object.assign(window, { chrome, fetch: async (u) => { fetchLog.push(u); throw new Error('unexpected fetch ' + u); } });
  const iframe = document.querySelector('iframe.docs-texteventtarget-iframe');
  const editorDoc = iframe.contentDocument;
  editorDoc.body.setAttribute('contenteditable', 'true');
  const ctx = dom.getInternalVMContext();
  const inject = () => new vm.Script(source('content.js'), { filename: 'content.js' }).runInContext(ctx);
  if (run) { inject(); await new Promise((r) => setTimeout(r, 10)); }
  // Calls every registered onMessage listener like Chrome does: resolves with the first response,
  // serialized like a real message (a plain object of this realm).
  const send = (msg) => new Promise((resolve) => {
    let answered = false;
    const respond = (r) => { if (!answered) { answered = true; resolve(r === undefined ? undefined : JSON.parse(JSON.stringify(r))); } };
    let async = false;
    for (const fn of chrome.runtime.onMessage.listeners) if (fn(msg, { id: 'testextid' }, respond) === true) async = true;
    if (!async) setTimeout(() => respond(undefined), 0);
  });
  const close = () => { clearTimers(); window.close(); };
  return { dom, window, document, chrome, storage, iframe, editorDoc, inject, send, sent, fetchLog, textResponse, close };
}

// ---- real DOM events -------------------------------------------------------------------------------
const click = (node) => { node.dispatchEvent(new node.ownerDocument.defaultView.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })); };
const mouse = (node, type, init = {}) => node.dispatchEvent(new node.ownerDocument.defaultView.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }));
const key = (node, k, init = {}) => {
  const ev = new node.ownerDocument.defaultView.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  node.dispatchEvent(ev);
  return ev;
};
// Sets the value of an input/textarea, puts the caret at the end (or at caret) and fires "input".
const typeInto = (node, value, caret = value.length) => {
  node.focus();
  node.value = value;
  node.setSelectionRange(caret, caret);
  node.dispatchEvent(new node.ownerDocument.defaultView.Event('input', { bubbles: true }));
};
const pointer = (node, type, init = {}) => {
  const W = node.ownerDocument.defaultView;
  const ev = new W.PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, ...init });
  node.dispatchEvent(ev);
  return ev;
};
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

module.exports = { load, loadContent, textResponse, click, mouse, key, typeInto, pointer, tick };
