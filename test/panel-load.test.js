'use strict';
// The panel's classic scripts share one global scope. Two modules that declare the same top-level name either fail
// at load ("Identifier 'x' has already been declared", for const / let / class) or, for two function declarations,
// silently replace the earlier one. Per-module tests do not see either, so this file loads every <script src> of
// sidepanel.html in order in ONE vm context with a minimal browser stub (main.js included), and checks the
// top-level declarations of all scripts for duplicates.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SCRIPTS = [...fs.readFileSync(path.join(ROOT, 'sidepanel.html'), 'utf8').matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);

// An element that accepts what the panel does to it at load time (listeners, classes, styles, text).
function element(id) {
  const classes = new Set();
  return {
    id, style: {}, dataset: {}, children: [], value: '', textContent: '', innerHTML: '', title: '', checked: false, disabled: false,
    offsetHeight: 0, scrollHeight: 0, scrollTop: 0, selectionStart: 0, selectionEnd: 0,
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)), remove: (...c) => c.forEach((x) => classes.delete(x)),
      toggle: (c, f) => { const on = f === undefined ? !classes.has(c) : !!f; if (on) classes.add(c); else classes.delete(c); return on; },
      contains: (c) => classes.has(c),
    },
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    appendChild: (c) => c, append() {}, prepend() {}, remove() {}, replaceWith() {}, insertBefore: (c) => c, replaceChildren() {},
    querySelector: () => null, querySelectorAll: () => [], closest: () => null, contains: () => false,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 400, bottom: 600, width: 400, height: 600 }),
    focus() {}, blur() {}, scrollIntoView() {}, setSelectionRange() {}, setPointerCapture() {}, releasePointerCapture() {},
  };
}

function browserStub() {
  const elements = new Map();
  const byId = (id) => { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id); };
  const area = () => ({ get: async () => ({}), set: async () => {}, remove: async () => {}, getKeys: async () => [] });
  const event = () => ({ addListener() {}, removeListener() {} });
  const chrome = {
    storage: { local: area(), session: area(), onChanged: event() },
    runtime: { id: 'loadtest', onMessage: event(), sendMessage: async () => ({}), getManifest: () => ({ version: '0', update_url: 'store' }), getURL: (p) => p },
    tabs: { query: async () => [], get: async () => { throw new Error('no tab'); }, sendMessage: async () => ({}), onActivated: event(), onUpdated: event() },
    scripting: { executeScript: async () => {} },
    permissions: { contains: async () => false, request: async () => false, remove: async () => true },
    identity: { launchWebAuthFlow: async () => { throw new Error('no flow'); }, getRedirectURL: () => 'https://loadtest.chromiumapp.org/' },
  };
  const document = {
    getElementById: byId, querySelector: () => element('q'), querySelectorAll: () => [], createElement: (t) => element(t),
    createTextNode: (t) => ({ textContent: t }), addEventListener() {}, removeEventListener() {}, activeElement: null,
    body: element('body'), documentElement: element('html'), hidden: false, visibilityState: 'visible',
  };
  const ctx = {
    console, chrome, document, location: { hash: '', search: '', href: 'chrome-extension://loadtest/sidepanel.html' },
    navigator: { userAgent: 'loadtest', clipboard: { writeText: async () => {} } },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    getComputedStyle: () => ({ display: 'block', paddingTop: '0', paddingBottom: '0', marginTop: '0', marginBottom: '0' }),
    requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
    setTimeout: (fn, ms, ...a) => { const t = setTimeout(fn, ms, ...a); t.unref(); return t; },
    clearTimeout, setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref(); return t; }, clearInterval,
    MutationObserver: class { observe() {} disconnect() {} }, ResizeObserver: class { observe() {} disconnect() {} },
    fetch: async () => { throw new Error('no network in the load test'); },
    TextEncoder, TextDecoder, AbortController, URL, URLSearchParams, crypto: globalThis.crypto,
    innerWidth: 400, innerHeight: 800, addEventListener() {}, removeEventListener() {}, focus() {},
  };
  ctx.window = ctx;
  ctx.self = ctx;
  return ctx;
}

test('every sidepanel.html script loads in order in one context (no SyntaxError, no ReferenceError)', async () => {
  assert.ok(SCRIPTS.length > 30 && SCRIPTS[0] === 'src/constants.js' && SCRIPTS.includes('src/main.js'), 'sidepanel.html lists the panel scripts');
  const ctx = browserStub();
  vm.createContext(ctx);
  const errors = [];
  // init() in main.js is an async IIFE: its errors arrive as unhandled rejections.
  const onRejection = (e) => errors.push(`main.js init: ${e && e.name}: ${e && e.message}`);
  process.on('unhandledRejection', onRejection);
  try {
    for (const f of SCRIPTS) {
      try {
        vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
      } catch (e) {
        errors.push(`${f}: ${e.name}: ${e.message}`);
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  } finally {
    process.off('unhandledRejection', onRejection);
  }
  assert.deepStrictEqual(errors.filter((e) => /SyntaxError|ReferenceError/.test(e)), [], 'scripts that fail to load');
  assert.deepStrictEqual(errors, [], 'other load errors');
  // Every script ran to its end: names from the first and the last modules are reachable in the one scope.
  assert.strictEqual(vm.runInContext('typeof registerTools + typeof sendMessage + typeof bindUi', ctx), 'functionfunctionfunction');
});

// Top-level declarations of a classic script: function / async function / class / const / let / var at column 0.
const DECL = /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|^(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;

test('no top-level name is declared by two panel scripts (a second function declaration would replace the first)', () => {
  const owner = new Map();
  const dups = [];
  for (const f of SCRIPTS) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of src.matchAll(DECL)) {
      const name = m[1] || m[2];
      if (owner.has(name) && owner.get(name) !== f) dups.push(`${name}: ${owner.get(name)} and ${f}`);
      else owner.set(name, f);
    }
  }
  assert.deepStrictEqual(dups, []);
  assert.ok(owner.size > 500, `found ${owner.size} top-level names`);
});
