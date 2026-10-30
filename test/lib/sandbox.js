'use strict';
// The stub browser the panel scripts run in: a minimal DOM (stubEl, document), chrome.* (storage.local /
// session, tabs, runtime, scripting; identity on request), timers and a fetch slot. load() builds a fresh
// vm context, runs the src/ files in sidepanel.html order and returns handles to reach the panel's internals.
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
// The panel's classic scripts in the order of their <script src> tags in sidepanel.html.
const SCRIPTS = [...fs.readFileSync(path.join(ROOT, 'sidepanel.html'), 'utf8').matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
// The OAuth client the tests sign in with, whatever src/constants.js ships (load({ googleClientId: '' }): a
// build without a client).
const TEST_CLIENT_ID = '999-web.apps.googleusercontent.com';
const CLIENT_ID_LINE = /^const GOOGLE_CLIENT_ID = '[^']*';$/m;
// The source of a panel script; constants.js gets the given client ID in place of the shipped one.
function panelSource(f, googleClientId = TEST_CLIENT_ID) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  if (f !== 'src/constants.js') return src;
  if (!CLIENT_ID_LINE.test(src)) throw new Error('src/constants.js: no "const GOOGLE_CLIENT_ID = \'…\';" line to override');
  return src.replace(CLIENT_ID_LINE, `const GOOGLE_CLIENT_ID = ${JSON.stringify(googleClientId)};`);
}
// Deep equality on the JSON form (values from the vm context have another realm's prototypes).
const deq = (a, b, m) => assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), m);

function stubEl(tag) {
  const classes = new Set();
  const listeners = {};
  const e = {
    tagName: tag, style: {}, dataset: {}, children: [], value: '', textContent: '', innerHTML: '', title: '', placeholder: '',
    offsetHeight: 0, disabled: false, selectionStart: 0, selectionEnd: 0,
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)), remove: (...c) => c.forEach((x) => classes.delete(x)),
      toggle: (c, f) => { if (f === undefined) f = !classes.has(c); if (f) classes.add(c); else classes.delete(c); return f; },
      contains: (c) => classes.has(c),
    },
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    appendChild(c) { if (c && typeof c === 'object') c.parentNode = e; e.children.push(c); return c; }, append(...c) { e.children.push(...c); },
    remove() { if (e.parentNode) { const i = e.parentNode.children.indexOf(e); if (i >= 0) e.parentNode.children.splice(i, 1); } e.parentNode = null; },
    // Like the DOM: the new node leaves its old place and takes this one's.
    replaceWith(n) {
      const p = e.parentNode;
      if (!p || !n) return;
      if (n.remove) n.remove();
      const i = p.children.indexOf(e);
      if (i >= 0) { p.children[i] = n; n.parentNode = p; }
      e.parentNode = null;
    },
    insertBefore(c) { e.children.push(c); return c; },
    querySelector() { return null; },
    querySelectorAll(sel) { const cls = sel.split('.').filter(Boolean); return e.children.filter((c) => c && c.classList && cls.every((k) => c.classList.contains(k))); },
    getBoundingClientRect() { return { left: 0, top: 0, right: 300, bottom: 400, width: 300, height: 400 }; },
    focus() {}, closest() { return null; }, contains() { return false; }, setSelectionRange() {},
    setPointerCapture() {}, releasePointerCapture() {},
  };
  Object.defineProperty(e, 'isConnected', { get: () => !!e.parentNode });
  Object.defineProperty(e, 'className', { get: () => [...classes].join(' '), set: (v) => { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((x) => classes.add(x)); } });
  return e;
}
// Loads the panel into a fresh context. Returns { ctx (the global object; assign ctx.fetch to mock the
// network), T (any top-level name of the panel: T.state, T.buildRequest, ...), get(name), run(code),
// state, PROVIDERS, document, elements, storage, chrome, timers }. opts.hash: the page's location.hash
// ('#tabId=7': the panel embedded in tab 7, HOST_TAB_ID); opts.googleClientId: the built-in OAuth client
// (default TEST_CLIENT_ID; '' for a build without one).
async function load({ settle = 30, hash = '', googleClientId = TEST_CLIENT_ID } = {}) {
  const elements = new Map();
  const document = {
    getElementById: (id) => { if (!elements.has(id)) elements.set(id, stubEl(id)); return elements.get(id); },
    createElement: (tag) => stubEl(tag),
    createTextNode: (t) => ({ textContent: t }),
    querySelector: () => stubEl('div'),
    addEventListener() {}, activeElement: null, body: stubEl('body'), documentElement: stubEl('html'),
  };
  const storage = {};
  const session = {}; // chrome.storage.session
  const chrome = {
    storage: {
      local: { get: async (keys) => { const out = {}; (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in storage) out[k] = storage[k]; }); return out; },
        set: async (items) => Object.assign(storage, items), remove: async (keys) => { (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete storage[k]); } },
      session: { get: async (keys) => { const out = {}; (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in session) out[k] = session[k]; }); return out; },
        set: async (items) => Object.assign(session, items), remove: async (keys) => { (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete session[k]); } },
    },
    tabs: { query: async () => [], get: async () => { throw new Error('no tab'); }, sendMessage: async () => ({}), onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
    runtime: { id: 'testextid', onMessage: { addListener() {} } },
    scripting: { executeScript: async () => {} },
  };
  const timers = [];
  const fakeSetTimeout = (fn, ms, ...a) => { const t = setTimeout(fn, ms, ...a); if (ms >= 500) t.unref(); timers.push({ fn, ms }); return t; };
  const sandbox = {
    console, document, chrome, location: { hash }, navigator: { clipboard: { writeText: async () => {} } },
    requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
    setTimeout: fakeSetTimeout, clearTimeout, TextDecoder, TextEncoder, AbortController, Promise, URL, URLSearchParams,
    MutationObserver: class { observe() {} }, getComputedStyle: () => ({ display: 'block', paddingTop: '0', paddingBottom: '0', marginTop: '0', marginBottom: '0' }),
    innerHeight: 800, innerWidth: 400, addEventListener() {}, focus() {},
    fetch: null,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  // One context for all files: like in a browser, top-level const/let/function of one script are visible to the next.
  for (const f of SCRIPTS) vm.runInContext(panelSource(f, googleClientId), sandbox, { filename: f });
  await new Promise((r) => setTimeout(r, settle)); // let init() settle
  const run = (code) => vm.runInContext(code, sandbox);
  const T = new Proxy({}, { get: (_, name) => (typeof name === 'string' && name !== 'then' ? run(name) : undefined) });
  return { ctx: sandbox, T, get: run, run, state: run('state'), PROVIDERS: run('PROVIDERS'), document, elements, storage, session, chrome, timers };
}

// A turn snapshot for the given provider (its settings get the API key 'k-<provider>' plus extra).
function makeSnapFor({ T, state }) {
  return (prov, extra = {}) => {
    state.settings.provider = prov;
    Object.assign(state.settings.providers[prov], { apiKey: 'k-' + prov, ...extra });
    const snap = T.takeSnapshot(); T.snapshotDocument(snap); return snap;
  };
}

// The Docs tab the panel belongs to (tab 7, document DOC123); chrome.tabs.sendMessage stays as it is.
function installDocTab({ chrome }) {
  const docTab = { id: 7, url: 'https://docs.google.com/document/d/DOC123/edit', title: 'My Doc - Google Docs' };
  chrome.tabs.query = async () => [docTab];
  chrome.tabs.get = async (id) => { if (id === 7) return docTab; throw new Error('no tab'); };
  return docTab;
}

// chrome.identity mock of Google's implicit flow (launchWebAuthFlow). ident.granted: the account has consented;
// ident.scopes: the granted scopes. An interactive flow grants the requested scopes (minus ident.withhold:
// scopes the user unticks in the consent) unless ident.failInteractive is set (the window closed: the flow
// rejects with that text). A silent flow (prompt=none) without the grant, or for a scope beyond it, answers
// #error=interaction_required. The redirect carries ident.token and the granted scopes. ident.calls logs
// interactive per flow, ident.requests the query of each. ident.forget() drops the panel's stored token, so
// that the next Docs API call renews it (and picks up a changed ident.token).
const SIGNIN_SCOPES = ['https://www.googleapis.com/auth/documents', 'openid', 'email', 'profile'];
function installIdentity(env) {
  const { chrome } = env;
  const ident = { granted: false, token: 'tok-1', calls: [], requests: [], failInteractive: null, withhold: [], scopes: SIGNIN_SCOPES.slice() };
  chrome.identity = {
    getRedirectURL: (p = '') => `https://${chrome.runtime.id}.chromiumapp.org/${p}`,
    launchWebAuthFlow: async ({ url, interactive }) => {
      const q = Object.fromEntries(new URL(url).searchParams);
      ident.calls.push(!!interactive);
      ident.requests.push(q);
      const want = String(q.scope || '').split(' ').filter(Boolean);
      if (interactive) {
        if (ident.failInteractive) throw new Error(ident.failInteractive);
        ident.granted = true;
        ident.scopes = [...new Set([...ident.scopes, ...want.filter((x) => !ident.withhold.includes(x))])];
      } else if (!ident.granted || want.some((x) => !ident.scopes.includes(x))) {
        return `${q.redirect_uri}#error=interaction_required`;
      }
      const got = want.filter((x) => ident.scopes.includes(x)).join(' ');
      return `${q.redirect_uri}#access_token=${ident.token}&token_type=Bearer&expires_in=3599&scope=${encodeURIComponent(got)}`;
    },
  };
  ident.forget = () => env.run("webToken = null; chrome.storage.session.remove('muninGoogleToken')");
  return ident;
}

const waitFor = async (cond, what) => {
  for (let i = 0; i < 400; i++) { if (cond()) return; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error('timed out waiting for ' + what);
};

// Wraps a provider fetch mock so that the panel's own export (…/export?format=…) answers HTTP 404 and the
// document comes from the stub content script's GET_DOC_TEXT (the fallback route of readExport).
const tabExportOnly = (f) => async (url, init) => (/docs\.google\.com\/document\/d\/[^/]+\/export\?/.test(String(url))
  ? { ok: false, status: 404, text: async () => 'Not found', headers: { get: () => null } } : f(url, init));

module.exports = { ROOT, SCRIPTS, TEST_CLIENT_ID, panelSource, deq, load, makeSnapFor, installDocTab, installIdentity, waitFor, tabExportOnly };
