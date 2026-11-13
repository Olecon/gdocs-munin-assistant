'use strict';
// The two marks of a newer version on GitHub (src/update-check.js) in the real DOM: the Settings version line
// (settings.js renderVersion: text nodes and one link) and the gear button's dot class and aria-label, with and without
// a newer version, from the stored record at the panel's start and from a storage change, and gone once the installed
// version has caught up. The bench loads a store install (its manifest has update_url: the check is off at load); each
// test makes it an unpacked install and calls startUpdateCheck, the panel's start. No request leaves the bench.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('../lib/dom-sandbox');

const KEY = 'muninUpdateCheck';
const PAGE = 'https://github.com/Olecon/gdocs-munin-assistant#update';
const deq = (a, b, m) => assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), m);

// A panel turned into an unpacked install of `installed`, the stored record `record`; change(rec) delivers a storage
// change of the record as Chrome does to every open panel.
async function unpacked({ installed = '9.8.7', record } = {}) {
  const env = await load({ storage: record ? { [KEY]: record } : {} });
  const fetches = [];
  env.ctx.fetch = async (url) => { fetches.push(url); throw new Error('unexpected fetch ' + url); };
  const listeners = [];
  env.chrome.storage.onChanged = { addListener: (fn) => listeners.push(fn) };
  env.chrome.runtime.getManifest = () => ({ version: installed });
  const change = (rec) => listeners.forEach((fn) => fn({ [KEY]: { oldValue: null, newValue: rec } }, 'local'));
  const { document } = env;
  return { env, fetches, change, installed, line: document.getElementById('settingsVersion'), gear: document.getElementById('settingsBtn') };
}

// Both marks for newer ('' or null: none).
function assertMarks(p, newer) {
  const { line, gear } = p;
  const links = line.querySelectorAll('a');
  if (newer) {
    assert.strictEqual(line.textContent, `Version ${p.installed} · ${newer} available · Update`);
    assert.strictEqual(links.length, 1);
    const a = links[0];
    deq([a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel'), a.textContent], [PAGE, '_blank', 'noopener noreferrer', 'Update']);
    assert.ok(gear.classList.contains('update-dot'));
    assert.strictEqual(gear.getAttribute('aria-label'), 'Settings (update available)');
  } else {
    assert.strictEqual(line.textContent, `Version ${p.installed}`);
    assert.strictEqual(links.length, 0);
    assert.ok(!gear.classList.contains('update-dot'));
    assert.strictEqual(gear.getAttribute('aria-label'), 'Settings');
  }
  // no hover text anywhere: no title, no data-tip
  assert.ok(!gear.hasAttribute('title') && !gear.hasAttribute('data-tip'));
  assert.ok(!line.hasAttribute('title') && !line.hasAttribute('data-tip') && !line.querySelector('[title], [data-tip]'));
}

test('at load (the bench is a store install): the version alone, a plain gear labelled Settings', async () => {
  const env = await load();
  assertMarks({ line: env.document.getElementById('settingsVersion'), gear: env.document.getElementById('settingsBtn'), installed: '9.8.7' }, null);
  assert.strictEqual(env.T.updateCheckOn(), false);
  env.close();
});

test('the stored newer version marks the line and the gear at the start, without a request; storage changes add and clear the marks', async () => {
  const p = await unpacked({ record: { at: Date.now(), ok: true, version: '9.9.0' } });
  try {
    await p.env.T.startUpdateCheck();
    deq(p.fetches, [], 'not due: no request');
    assertMarks(p, '9.9.0');
    // another panel stored a newer version: one link, not a second one
    p.change({ at: Date.now(), ok: true, version: '9.10.0' });
    assertMarks(p, '9.10.0');
    // GitHub has the installed version (or an older one): both marks go
    p.change({ at: Date.now(), ok: true, version: '9.8.7' });
    assertMarks(p, null);
    p.change({ at: Date.now(), ok: true, version: '9.8.6' });
    assertMarks(p, null);
    p.change({ at: Date.now(), ok: true, version: '10.0' });
    assertMarks(p, '10.0');
    p.change(undefined); // the record removed
    assertMarks(p, null);
  } finally { p.env.close(); }
});

test('after the update the installed version has caught up: nothing is marked', async () => {
  const p = await unpacked({ installed: '9.9.0', record: { at: Date.now(), ok: true, version: '9.9.0' } });
  try {
    await p.env.T.startUpdateCheck();
    assertMarks(p, null);
    deq(p.fetches, []);
  } finally { p.env.close(); }
});

test('a due check that fails (the bench refuses the request) keeps the marks of the stored version and adds nothing to the chat', async () => {
  const p = await unpacked({ record: { at: Date.now() - 2 * 24 * 3600 * 1000, ok: true, version: '9.9.0' } });
  try {
    const chatBefore = p.env.el.chat.innerHTML;
    await p.env.T.startUpdateCheck();
    deq(p.fetches, [p.env.T.UPDATE_MANIFEST_URL]);
    assertMarks(p, '9.9.0');
    deq([p.env.storage[KEY].ok, p.env.storage[KEY].version], [false, '9.9.0']);
    assert.strictEqual(p.env.el.chat.innerHTML, chatBefore);
  } finally { p.env.close(); }
});

test('renderVersion builds the line from text nodes: markup in the version stays text', async () => {
  const env = await load();
  try {
    const line = env.document.getElementById('settingsVersion');
    env.T.renderVersion('<img src=x onerror="alert(1)">');
    assert.strictEqual(line.querySelector('img'), null);
    assert.strictEqual(line.textContent, 'Version 9.8.7 · <img src=x onerror="alert(1)"> available · Update');
    deq([...line.childNodes].map((n) => n.nodeName), ['#text', '#text', 'A']);
    env.T.renderVersion();
    assert.strictEqual(line.innerHTML, 'Version 9.8.7');
  } finally { env.close(); }
});

test('the gear dot: an absolute 6 px accent dot at the top right corner that moves nothing; the link in the accent colour', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', '..', 'sidepanel.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2].replace(/\s+/g, ' ').trim() }));
  const dot = rules.filter((r) => r.sel.includes('update-dot'));
  deq(dot.map((r) => r.sel), ['#settingsBtn.update-dot', '#settingsBtn.update-dot::after']);
  // the button itself only becomes the dot's containing block: no size, padding, margin or border change
  assert.strictEqual(dot[0].body, 'position: relative;');
  const after = dot[1].body;
  for (const d of ['content: "";', 'position: absolute;', 'top: 0;', 'right: 0;', 'width: 6px;', 'height: 6px;', 'border-radius: 50%;', 'background: var(--accent);', 'pointer-events: none;']) {
    assert.ok(after.includes(d), d);
  }
  // --accent exists in the dark tokens and in both light blocks (the dot reads in either theme)
  assert.strictEqual((css.match(/--accent: #[0-9a-f]{6};/g) || []).length, 3);
  assert.ok(rules.some((r) => r.sel === '.settings-version a' && r.body === 'color: var(--accent-hover);'));
});
