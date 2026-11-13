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
// The access cards: waiting (a boxed card with buttons) and answered (one row, gate.js answerCard).
const cards = () => [...el.chat.querySelectorAll('.tool-card.preview.access, .answered-row.access')];
const openCard = () => cards().find((c) => c.classList.contains('tool-card') && !c.classList.contains('decided')) || null;
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
  T.refsDeclined.clear(); // a Not now holds for the chat: every test starts without one
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
  // words, not a DOI: only the Zotero library is asked, so only Zotero is named
  assert.strictEqual(card.querySelector('.pv-note').textContent,
    'The assistant wants to look up references through Zotero (on this computer). To find works to cite.');
  deq([...card.querySelectorAll('button')].map((b) => b.textContent), ['Allow', 'Not now']);
  assert.strictEqual(T.pendingPreviews.size, 1);
  click(card.querySelector('button[data-access="allow"]'));
  deq(asked, [['http://localhost:23119/*', 'https://api.crossref.org/*', 'https://api.openalex.org/*']]); // inside the click
  const r = await p;
  assert.ok(r._ok && r.content.startsWith('1 Zotero item for "smith 2020"'), r.content);
  deq([state.settings.references, env.storage.muninReferences, T.pendingPreviews.size], [true, true, 0]);
  assert.strictEqual(card.querySelector('summary').textContent,
    'References · Allowed · The assistant wants to look up references through Zotero (on…'); // the request clipped (cardPreview)
  assert.strictEqual(card.querySelector('.log-body .log-what').textContent, 'Zotero');
  assert.ok(card.querySelector('.log-body .log-asked').textContent.endsWith('To find works to cite.'));
  // granted: no card in a later turn
  const r2 = await T.executeTool(call('r2'), 'manual', snap(), {});
  assert.ok(r2._ok, r2.content);
  deq([asked.length, openCard()], [1, null]);
});

test('Not now: the model-facing refusal; a second call in the same turn gets it without a card; so do later turns of the chat until a message asks for a lookup', async () => {
  reset();
  const s = snap();
  const p = T.executeTool(call('n1'), 'manual', s, {});
  await waitFor(() => openCard(), 'the access card');
  click(openCard().querySelector('button[data-access="later"]'));
  const r = await p;
  deq([r.content, r._ok, asked.length, z.calls.length], ['Reference lookups were not allowed. Call find_reference or cite again only if the user asks for a lookup; a citation the user gives or wants as plain text needs none: type it.', false, 0, 0]);
  // the card stays as its answered row: "Not now", the request in its fold, no buttons
  deq([cards().length, cards()[0].classList.contains('answered-row'), cards()[0].querySelector('.log-status').textContent, cards()[0].querySelectorAll('button').length], [1, true, 'Not now', 0]);
  deq(r._answered.map((a) => [a.kind, a.decision]), [['access', 'reject']]);
  assert.strictEqual(r.content, T.REFS_DENIED_TEXT);
  const again = await T.executeTool(call('n2', 'check_references', {}), 'manual', s, {});
  deq([again.content, T.pendingPreviews.size, cards().filter((c) => !c.classList.contains('answered-row')).length], [T.REFS_DENIED_TEXT, 0, 0]);
  // later turns of the chat: no card while the newest message does not ask for a lookup itself
  const turn = (text) => snap({ chatCtx: { docId: state.docId, chatId: state.chatId, messages: [{ role: 'user', content: text }] } });
  for (const text of ['Как [doi]', 'Добавь сам цитаты', 'Почему?', 'Put them in as plain text [doi].', 'Почему ты вызываешь Zotero?!']) { // a source named in a complaint is no request
    const r2 = await T.executeTool(call('n3'), 'manual', turn(text), {});
    deq([text, r2.content, T.pendingPreviews.size], [text, T.REFS_DENIED_TEXT, 0]);
  }
  // another chat asks
  const other = T.executeTool(call('n4'), 'manual', snap({ chatCtx: { docId: state.docId, chatId: 'other-chat', messages: [{ role: 'user', content: 'Add a citation.' }] } }), {});
  await waitFor(() => openCard(), 'the card of another chat');
  click(openCard().querySelector('button[data-access="later"]'));
  assert.strictEqual((await other).content, T.REFS_DENIED_TEXT);
  // a message that asks for a lookup shows the card again; Allow ends the refusal
  const p3 = T.executeTool(call('n5'), 'manual', turn('Look up the references in Zotero, please.'), {});
  await waitFor(() => openCard(), 'the card of a turn that asks');
  click(openCard().querySelector('button[data-access="later"]'));
  assert.strictEqual((await p3).content, T.REFS_DENIED_TEXT);
  assert.strictEqual(state.settings.references, false);
  const pz = T.executeTool(call('n5z'), 'manual', turn('найди в Zotero'), {});
  await waitFor(() => openCard(), 'the card of "найди в Zotero"');
  click(openCard().querySelector('button[data-access="later"]'));
  assert.strictEqual((await pz).content, T.REFS_DENIED_TEXT);
  const p4 = T.executeTool(call('n6'), 'manual', turn('Найди DOI этой статьи'), {});
  await waitFor(() => openCard(), 'the card of a Russian request');
  click(openCard().querySelector('button[data-access="allow"]'));
  assert.ok((await p4)._ok);
  assert.ok(!T.refsDeclined.size || ![...T.refsDeclined].some((k) => k.endsWith(`\u0000${state.chatId}`)));
});

test('the card names the sources the call asks: a DOI only Crossref, check_references Crossref and OpenAlex, cite by its ids', async () => {
  reset();
  const named = async (c) => {
    const p = T.executeTool(c, 'manual', snap(), {});
    await waitFor(() => openCard(), 'the access card');
    const card = openCard();
    const text = card.querySelector('.pv-note').textContent;
    click(card.querySelector('button[data-access="later"]'));
    await p;
    T.refsDeclined.clear();
    return text;
  };
  assert.strictEqual(await named(call('s1', 'find_reference', { query: 'doi:10.1038/nphys1234' })), 'The assistant wants to look up references through Crossref. To find works to cite.');
  assert.strictEqual(await named(call('s2', 'check_references', {})), 'The assistant wants to look up references through Crossref and OpenAlex. To check the reference list.');
  deq([T.citeSources({ action: 'insert', ids: ['doi:10.1000/x'] }), T.citeSources({ action: 'insert', ids: ['zotero:ABCD1234', 'doi:10.1000/x'] }),
    T.citeSources({ action: 'refresh', ids: null })], [['Crossref'], ['Zotero', 'Crossref'], ['Zotero', 'Crossref', 'OpenAlex']]);
  deq([T.asksLookup('check the references against Crossref'), T.asksLookup('проверь ссылки'), T.asksLookup('Find papers on rafts'),
    T.asksLookup('find it in Zotero'), T.asksLookup('проверь по Crossref'), T.asksLookup('найди в Zotero'),
    T.asksLookup('Как [doi]'), T.asksLookup('Внеси их в документ'), T.asksLookup('add the citations as text'),
    T.asksLookup('Почему ты вызываешь Zotero?!'), T.asksLookup('I do not use Zotero or Crossref.')],
  [true, true, true, true, true, true, false, false, false, false, false]);
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
    assert.ok(!head.includes('find_reference'), text); // no prompt line: its definition describes it
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
