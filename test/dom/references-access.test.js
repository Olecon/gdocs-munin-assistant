'use strict';
// References on demand (src/references.js, the access card of src/gate.js; jsdom, a fake Zotero): without the grant a
// reference tool shows a card in the chat; Allow asks Chrome for REFERENCES_ORIGINS from the click, stores the grant
// and the call runs; Not now, a refusal by Chrome and Stop give the model-facing refusal; one card per turn; a quiet
// turn never asks; a failed lookup re-checks the permissions. The keyword gate: without the grant the tools are offered
// only when the message or the document instructions mention references (English and Russian).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { load, click } = require('../lib/dom-sandbox');
const { deq, waitFor } = require('../lib/sandbox');
const { fakeZotero } = require('../lib/fake-zotero');

let env, T, state, el, z;
let asked = [];
let grant = true;
let granted = false;
const cards = () => [...el.chat.querySelectorAll('.tool-card.preview.access')];
const openCard = () => cards().find((c) => !c.classList.contains('decided')) || null;
const call = (id, name = 'find_reference', args = { query: 'smith 2020' }) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
function snap(extra = {}) {
  const s = T.takeSnapshot();
  s.signal = new AbortController().signal;
  s.refsOffer = true; // as the beforeTurn hook fixes it for a turn that mentions references
  return Object.assign(s, extra);
}
function reset() {
  state.settings.references = false;
  delete env.storage.muninReferences;
  asked = [];
  grant = true;
  granted = false;
  z.calls.length = 0;
  el.chat.textContent = '';
}

before(async () => {
  env = await load();
  ({ T, state, el } = env);
  z = fakeZotero();
  env.ctx.fetch = async (url, init) => (await z.fetch(url, init)) || { ok: false, status: 404, text: async () => '' };
  env.chrome.permissions = {
    request: async (p) => { asked.push(p.origins); granted = granted || grant; return grant; },
    contains: async () => granted,
  };
});
after(() => env.close());

test('the card: its text and buttons; Allow asks Chrome for the three origins, stores the grant and the call runs', async () => {
  reset();
  const p = T.executeTool(call('r1'), 'manual', snap(), {});
  await waitFor(() => openCard(), 'the access card');
  const card = openCard();
  assert.strictEqual(card.querySelector('.pv-note').textContent,
    'The assistant wants to look up references through Zotero (on this computer), Crossref and OpenAlex. To find works to cite.');
  deq([...card.querySelectorAll('button')].map((b) => b.textContent), ['Allow', 'Not now']);
  assert.strictEqual(T.pendingPreviews.size, 1);
  click(card.querySelector('button[data-access="allow"]'));
  deq(asked, [['http://localhost:23119/*', 'https://api.crossref.org/*', 'https://api.openalex.org/*']]); // inside the click
  const r = await p;
  assert.ok(r._ok && r.content.startsWith('1 Zotero item for "smith 2020"'), r.content);
  deq([state.settings.references, env.storage.muninReferences, T.pendingPreviews.size], [true, true, 0]);
  // granted: no card in a later turn
  const r2 = await T.executeTool(call('r2'), 'manual', snap(), {});
  assert.ok(r2._ok, r2.content);
  deq([asked.length, openCard()], [1, null]);
});

test('Not now: the model-facing refusal; a second call in the same turn gets it without a card; the next turn asks again', async () => {
  reset();
  const s = snap();
  const p = T.executeTool(call('n1'), 'manual', s, {});
  await waitFor(() => openCard(), 'the access card');
  click(openCard().querySelector('button[data-access="later"]'));
  const r = await p;
  deq([r.content, r._ok, asked.length, z.calls.length], ['The user did not allow reference lookups in this message.', false, 0, 0]);
  assert.strictEqual(r.content, T.REFS_DENIED_TEXT);
  const again = await T.executeTool(call('n2', 'check_references', {}), 'manual', s, {});
  deq([again.content, T.pendingPreviews.size, cards().filter((c) => !c.classList.contains('decided')).length], [T.REFS_DENIED_TEXT, 0, 0]);
  const p3 = T.executeTool(call('n3'), 'manual', snap(), {});
  await waitFor(() => openCard(), 'the card of the next turn');
  click(openCard().querySelector('button[data-access="later"]'));
  assert.strictEqual((await p3).content, T.REFS_DENIED_TEXT);
  assert.strictEqual(state.settings.references, false);
});

test('Chrome refuses: the refusal, nothing stored; Stop rejects the card; a quiet turn never asks', async () => {
  reset();
  grant = false;
  let p = T.executeTool(call('c1'), 'manual', snap(), {});
  await waitFor(() => openCard(), 'the access card');
  click(openCard().querySelector('button[data-access="allow"]'));
  let r = await p;
  deq([r.content, asked.length, state.settings.references, env.storage.muninReferences], [T.REFS_DENIED_TEXT, 1, false, undefined]);
  // Stop
  const ctrl = new AbortController();
  p = T.executeTool(call('c2'), 'manual', snap({ signal: ctrl.signal }), {});
  await waitFor(() => openCard(), 'the second card');
  ctrl.abort();
  r = await p;
  deq([r.content, T.pendingPreviews.size, asked.length], [T.REFS_DENIED_TEXT, 0, 1]);
  // the self-test (quiet): no card
  r = await T.executeTool(call('c3'), 'manual', snap({ quiet: true }), {});
  deq([r.content, T.pendingPreviews.size], [T.REFS_DENIED_TEXT, 0]);
});

test('requestReferencesAccess: true at once with the grant; a failed lookup re-checks Chrome and forgets a revoked grant', async () => {
  reset();
  state.settings.references = true;
  granted = true;
  assert.strictEqual(await T.requestReferencesAccess('Why.'), true);
  assert.strictEqual(openCard(), null);
  // Zotero not running: the error goes to the model; Chrome still grants, so the grant stays
  z.running = false;
  T.resetZoteroStatus();
  let r = await T.executeTool(call('f1'), 'manual', snap(), {});
  assert.ok(r.content.startsWith('Error: Zotero is not running'), r.content);
  assert.strictEqual(state.settings.references, true);
  // revoked in chrome://extensions: the next failure resets the grant, so the card appears again
  granted = false;
  T.resetZoteroStatus();
  r = await T.executeTool(call('f2'), 'manual', snap(), {});
  assert.ok(r.content.startsWith('Error:'), r.content);
  deq([state.settings.references, env.storage.muninReferences], [false, false]);
  z.running = true;
  T.resetZoteroStatus();
  const p = T.executeTool(call('f3'), 'manual', snap(), {});
  await waitFor(() => openCard(), 'the card again');
  click(openCard().querySelector('button[data-access="later"]'));
  await p;
});

test('the keyword gate: without the grant offered only when the message or the document instructions mention references', async () => {
  reset();
  const names = async (text, instructions = '') => {
    T.addUserBubble(text);
    const s = T.takeSnapshot();
    s.docInstructions = instructions;
    await T.beforeTurnLines('manual', s);
    return { tools: T.toolsFor('manual', s).map((t) => t.function.name), head: T.buildSystemParts('manual', 1e5, s).head };
  };
  for (const text of ['Add a citation after the first sentence.', 'добавь ссылку на источник', 'Check my bibliography', 'Find the DOI of this paper', 'Оформи список литературы']) {
    const { tools, head } = await names(text);
    assert.ok(tools.includes('find_reference'), text);
    assert.ok(head.includes('- find_reference(query)'), text);
  }
  let { tools, head } = await names('Shorten the introduction.');
  assert.ok(!tools.includes('find_reference') && !tools.includes('check_references'), tools.join());
  assert.ok(!head.includes('find_reference') && !head.includes('check_references'));
  ({ tools } = await names('Shorten the introduction.', 'Cite in APA style.'));
  assert.ok(tools.includes('find_reference'));
  state.settings.references = true;
  ({ tools } = await names('Shorten the introduction.'));
  assert.ok(tools.includes('find_reference'));
  // the offer stays fixed for the turn even when the grant changes meanwhile
  T.addUserBubble('Shorten the introduction.');
  const s = T.takeSnapshot();
  await T.beforeTurnLines('manual', s);
  state.settings.references = false;
  assert.ok(T.toolsFor('manual', s).map((t) => t.function.name).includes('find_reference'));
  deq([T.refsMentioned('see the references'), T.refsMentioned('цитирование'), T.refsMentioned('preferences and docile'), T.refsMentioned('')], [true, true, false, false]);
  T.addUserBubble('');
});
