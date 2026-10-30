'use strict';
// The "@" Zotero autocomplete in the composer (slash.js + references.js, jsdom, a fake Zotero): with References on,
// "@" plus 2+ letters opens the popup after the debounce with matching library items, a click on a row puts the
// item's token into the message (no keyboard needed), the sent message's user bubble shows it as a chip, and the
// turn context gets one line with the picked ids (the beforeTurn hook); without the grant the chat asks once per panel load.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { load, mouse, key, typeInto, tick, click } = require('../lib/dom-sandbox');
const { deq, installDocTab, waitFor } = require('../lib/sandbox');
const { sseResponse, textRound } = require('../lib/streams');
const { fakeZotero } = require('../lib/fake-zotero');

let env, T, state, el, z;
let bodies = [];
const searches = () => z.calls.filter((c) => /[?&]q=/.test(c.url)).map((c) => new URL(c.url).searchParams.get('q'));
const rows = () => [...el.cmdPopup.querySelectorAll('.cmd-row')];

before(async () => {
  env = await load();
  ({ T, state, el } = env);
  installDocTab(env);
  env.chrome.tabs.sendMessage = async (id, msg) => {
    switch (msg.type) {
      case 'PING': return { ok: true, title: 'My Doc' };
      case 'GET_SELECTION': return { ok: true, text: '' };
      case 'GET_DOC_TEXT': return { ok: true, text: '# My Doc\n\nAlpha line.', format: 'markdown', title: 'My Doc' };
      default: return { ok: true };
    }
  };
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic';
  Object.assign(state.settings.providers.anthropic, { apiKey: 'sk-ant-test', model: 'claude-opus-5-5' });
  z = fakeZotero();
  env.ctx.fetch = async (url, init) => {
    const zr = await z.fetch(url, init);
    if (zr) return zr;
    if (String(url).includes('api.anthropic.com')) { bodies.push(JSON.parse(init.body)); return sseResponse(textRound('Noted.')); }
    return { ok: false, status: 404, text: async () => '' };
  };
});
after(() => env.close());

function reset(references) {
  state.settings.references = references;
  z.calls.length = 0;
  T.resetZoteroStatus();
  T.closePopup();
  typeInto(el.input, '');
}

test('"@smi" opens the popup after the debounce with the matching items; one search for quick typing', async () => {
  reset(true);
  typeInto(el.input, 'As shown by @sm');
  await tick(50);
  typeInto(el.input, 'As shown by @smi'); // typed on within the debounce: only this query is searched
  assert.ok(el.cmdPopup.classList.contains('hidden'));
  await waitFor(() => !el.cmdPopup.classList.contains('hidden'), 'the popup');
  assert.deepStrictEqual(searches(), ['smi']);
  assert.strictEqual(rows().length, 1);
  assert.strictEqual(rows()[0].querySelector('.cmd-name').textContent, 'Smith & Lee 2020');
  assert.strictEqual(rows()[0].querySelector('.cmd-desc').textContent, 'Lipid rafts in membranes');
  assert.strictEqual(el.cmdPopup.getAttribute('aria-label'), 'Zotero items');
  // a click picks it: the token replaces "@smi", the caret after it; the popup closes
  mouse(rows()[0], 'mousedown');
  assert.strictEqual(el.input.value, 'As shown by @[Smith & Lee 2020: Lipid rafts in membranes](zotero:ABCD1234) ');
  assert.strictEqual(el.input.selectionStart, el.input.value.length);
  assert.ok(el.cmdPopup.classList.contains('hidden'));
});

test('up to eight items; Escape closes; text after the caret stays', async () => {
  reset(true);
  typeInto(el.input, 'Cite @20 here', 'Cite @20'.length); // "20" matches both items' years
  await waitFor(() => rows().length === 2, 'two rows');
  assert.ok(rows().length <= T.ZOTERO_PICK_MAX);
  assert.strictEqual(key(el.input, 'Escape').defaultPrevented, true);
  assert.ok(el.cmdPopup.classList.contains('hidden'));
  typeInto(el.input, 'Cite @bro here', 'Cite @bro'.length);
  await waitFor(() => rows().length === 1, 'Brown');
  mouse(rows()[0], 'mousedown');
  assert.strictEqual(el.input.value, 'Cite @[Brown 2018: Cholesterol and order](zotero:EFGH5678) here');
});

test('without the grant "@smi" asks once per panel load (Not now: "@" stays inert); nothing for one letter, inside a word, or without Zotero', async () => {
  reset(false);
  const asked = [];
  env.chrome.permissions = { request: async (p) => { asked.push(p.origins); return false; }, contains: async () => false };
  typeInto(el.input, 'See @smith');
  const access = () => [...el.chat.querySelectorAll('.tool-card.preview.access')];
  await waitFor(() => access().length === 1, 'the access card');
  assert.match(access()[0].querySelector('.pv-note').textContent, /Zotero \(on this computer\), Crossref and OpenAlex\. To list works from your Zotero library as you type @\.$/);
  click(access()[0].querySelector('button[data-access="later"]'));
  await waitFor(() => !access().length, 'the card removed');
  typeInto(el.input, 'See @smit');
  await tick(400);
  deq([access().length, asked.length, z.calls.length, el.cmdPopup.classList.contains('hidden'), T.pendingPreviews.size], [0, 0, 0, true, 0]);
  reset(true);
  for (const v of ['See @s', 'mail me at john@smith']) {
    typeInto(el.input, v);
    await tick(400);
    assert.ok(el.cmdPopup.classList.contains('hidden'), v);
  }
  assert.deepStrictEqual(searches(), []);
  z.running = false;
  typeInto(el.input, 'See @smith');
  await tick(400);
  assert.ok(el.cmdPopup.classList.contains('hidden'));
  z.running = true;
});

test('zoteroMentionsLine: one line per message, each key once, the label as author (year), title', () => {
  const t = 'Compare @[Smith & Lee 2020: Lipid rafts in membranes](zotero:ABCD1234) with @[Brown 2018: Cholesterol and…](zotero:efgh5678) and @[Smith & Lee 2020: Lipid rafts in membranes](zotero:ABCD1234).';
  assert.strictEqual(T.zoteroMentionsLine(t),
    'Zotero items the user mentioned (ids for cite): zotero:ABCD1234 = Smith & Lee (2020), Lipid rafts in membranes; zotero:EFGH5678 = Brown (2018), Cholesterol and…');
  assert.strictEqual(T.zoteroMentionsLine('No picks, just @smith and [x](zotero:SHORT)'), '');
  assert.strictEqual(T.zoteroToken({ key: 'ABCD1234', who: 'Doe', year: 'n.d.', title: 'A [bracketed] title that is much longer than thirty' }),
    '@[Doe n.d.: A (bracketed) title that is…](zotero:ABCD1234)');
});

test('a sent message: a chip in the user bubble, the context line in the request; none without References', async () => {
  reset(true);
  await T.createChat();
  bodies = [];
  typeInto(el.input, 'Cite @[Smith & Lee 2020: Lipid rafts in membranes](zotero:ABCD1234) after the first sentence.');
  key(el.input, 'Enter');
  await waitFor(() => bodies.length === 1 && !state.busy, 'the turn');
  const user = JSON.stringify(bodies[0].messages.filter((m) => m.role === 'user').pop());
  assert.ok(user.includes('Zotero items the user mentioned (ids for cite): zotero:ABCD1234 = Smith & Lee (2020), Lipid rafts in membranes'));
  const bubble = [...el.chat.querySelectorAll('.msg.user')].pop();
  const chip = bubble.querySelector('.zotero-chip');
  assert.strictEqual(chip.textContent, 'Smith & Lee 2020: Lipid rafts in membranes');
  assert.strictEqual(chip.title, 'Zotero item ABCD1234');
  assert.ok(bubble.textContent.startsWith('Cite Smith & Lee 2020'));
  reset(false);
  await T.createChat();
  bodies = [];
  typeInto(el.input, 'Cite @[Smith & Lee 2020: Lipid rafts](zotero:ABCD1234) here.');
  key(el.input, 'Enter');
  await waitFor(() => bodies.length === 1 && !state.busy, 'the second turn');
  assert.ok(!JSON.stringify(bodies[0]).includes('Zotero items the user mentioned'));
});

test('a fresh panel without the grant: "@smi" shows the card; Allow asks Chrome, stores the grant and opens the popup', async () => {
  const e = await load();
  try {
    installDocTab(e);
    const zz = fakeZotero();
    e.ctx.fetch = async (url, init) => (await zz.fetch(url, init)) || { ok: false, status: 404, text: async () => '' };
    const asked = [];
    e.chrome.permissions = { request: async (p) => { asked.push(p.origins); return true; }, contains: async () => true };
    assert.strictEqual(e.state.settings.references, false);
    typeInto(e.el.input, 'See @smith');
    const card = () => e.el.chat.querySelector('.tool-card.preview.access');
    await waitFor(() => card(), 'the access card');
    click(card().querySelector('button[data-access="allow"]'));
    deq(asked, [['http://localhost:23119/*', 'https://api.crossref.org/*', 'https://api.openalex.org/*']]);
    await waitFor(() => !e.el.cmdPopup.classList.contains('hidden'), 'the popup');
    deq([e.state.settings.references, e.storage.muninReferences, !!card()], [true, true, false]);
    assert.match(e.el.cmdPopup.textContent, /Smith & Lee 2020/);
  } finally { e.close(); }
});
