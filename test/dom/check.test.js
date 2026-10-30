'use strict';
// /check on a real DOM (jsdom): sending "/check" runs the report without a model call (no history, the input emptied),
// the card's groups, severities and line links, a line link sends SCROLL_TO_LINE to the Docs tab (and a miss gives
// the notice), Copy report copies the Markdown, the export note, and the reference-list phase with References on
// (progress, the verdicts in the card, Cancel).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { load, click, tick } = require('../lib/dom-sandbox');
const { deq, installDocTab, installIdentity, waitFor } = require('../lib/sandbox');
const { docsBench } = require('../lib/fake-docs');
require('../lib/fake-comments');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, el, chrome, tabMsgs, scrollReply, bench;
const DOC = [
  '# Lipase paper', '', '## Abstract', '', 'Activity towards PNPB was high (Moreno, 2018).', '', '## Methods', '',
  'We used p-nitrophenyl butyrate (PNPB) and the yield was [[?]] mg, see Fig. 2.', '', '## References', '',
  'Smith J. (2020). Interfacial activation of bacterial lipases. Journal of Catalysis 18, 45–58.',
].join('\n');

before(async () => {
  env = await load();
  ({ T, state, el, chrome } = env);
  bench = docsBench(env, installIdentity(env), ref);
  installDocTab(env);
  tabMsgs = [];
  scrollReply = { ok: true, how: 'aria-paragraph' };
  chrome.tabs.sendMessage = async (id, msg) => {
    tabMsgs.push(msg);
    switch (msg.type) {
      case 'PING': return { ok: true, title: 'Lipase paper' };
      case 'GET_SELECTION': return { ok: true, text: '' };
      case 'GET_DOC_TEXT': return { ok: true, text: DOC, format: 'markdown', title: 'Lipase paper' };
      case 'SCROLL_TO_LINE': return scrollReply;
      default: return { ok: true };
    }
  };
  await T.refreshContext({ force: true });
});
after(() => env.close());

const card = () => [...el.chat.querySelectorAll('.msg.check-report')].pop() || null;
const groupItems = (id) => [...card().querySelectorAll(`.ck-group[data-group="${id}"] .ck-item`)].map((n) => n.textContent.replace(/\s+/g, ' ').trim());

test('/check: the report card without a model call; groups with severities and line links; nothing stored', async () => {
  const fetched = [];
  env.ctx.fetch = async (url) => { fetched.push(String(url)); throw new Error('Failed to fetch'); };
  state.messages = [];
  el.input.value = '/check';
  await T.sendMessage();
  await waitFor(() => card() && !state.busy, 'the report');
  assert.strictEqual(el.input.value, '');
  assert.deepStrictEqual(state.messages, []);
  assert.ok(fetched.every((u) => /docs\.google\.com\/document\/d\/DOC123\/export/.test(u)), fetched.join('\n')); // only the export
  const c = card();
  assert.match(c.querySelector('.ck-head').textContent, /Check · .* · «Lipase paper» · export \(Markdown\)/);
  assert.match(c.querySelector('.ck-sub').textContent, /Read through the export/);
  assert.deepStrictEqual(groupItems('acronyms'), ['⚠️ line 5 PNPB is used before its definition on line 9 (p-nitrophenyl butyrate).']);
  assert.deepStrictEqual(groupItems('pointers'), ['❌ line 9 Figure 2 is mentioned but there is no caption "Figure 2." at a line start.']);
  assert.deepStrictEqual(groupItems('references'), ['❌ line 5 Moreno, 2018 matches no entry of the reference list.', '⚠️ line 13 Smith (2020) is never cited in the text.']);
  assert.deepStrictEqual(groupItems('placeholders'), ['❌ line 9 Open placeholder [[?]].']);
  assert.deepStrictEqual(groupItems('reflist'), ['ℹ️ Not checked: reference lookups through Crossref and OpenAlex are not allowed yet. Allow lookups']);
  assert.ok(c.querySelector('.ck-group[data-group="reflist"] button.ck-allow'));
  assert.match(c.querySelector('.ck-summary').textContent, /^3 errors, 2 warnings, \d+ notes$/);
  assert.ok(c.querySelector('.ck-error'));
  // the Markdown copy
  click(c.querySelector('button[data-act="copy-selftest"]'));
  await tick(5);
  const md = env.clipboard.writes.pop();
  assert.match(md, /^## Munin check\n\n- Date: .*\n- Document: «Lipase paper» \(DOC123\) · export \(Markdown\)\n/);
  assert.ok(md.includes('### Acronyms\n\n- ⚠️ warning · line 5 · PNPB is used before its definition on line 9 (p-nitrophenyl butyrate).'));
  assert.ok(md.includes('### Placeholders\n\n- ❌ error · line 9 · Open placeholder [[?]].'));
  assert.ok(md.includes('### Word budgets\n\n- ℹ️ note · No budget line'));
  // a re-render drops the card (a notice, not history)
  T.renderHistory();
  assert.strictEqual(card(), null);
});

test('a line link sends SCROLL_TO_LINE with the line, its text and the line count; a miss shows the notice', async () => {
  env.ctx.fetch = async () => { throw new Error('Failed to fetch'); };
  el.input.value = '/check';
  await T.sendMessage();
  await waitFor(() => card() && !state.busy, 'the report');
  tabMsgs.length = 0;
  const link = card().querySelector('.ck-group[data-group="placeholders"] button.ck-line');
  assert.strictEqual(link.textContent, 'line 9');
  click(link);
  await waitFor(() => tabMsgs.some((m) => m.type === 'SCROLL_TO_LINE'), 'the message');
  const msg = tabMsgs.find((m) => m.type === 'SCROLL_TO_LINE');
  deq(msg, { type: 'SCROLL_TO_LINE', line: 9, text: 'We used p-nitrophenyl butyrate (PNPB) and the yield was [[?]] mg, see Fig. 2.', of: 13 });
  await tick(5);
  assert.ok(![...el.chat.querySelectorAll('.msg.notice')].some((n) => n.textContent === T.SCROLL_NOT_FOUND));
  scrollReply = { ok: false, reason: 'not-found' };
  const r = await T.scrollToLine(5, 'Activity towards PNPB was high');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), { ok: false, reason: 'not-found' });
  assert.ok([...el.chat.querySelectorAll('.msg.notice')].some((n) => n.textContent === 'Could not find the line in the editor view.'));
  scrollReply = { ok: true, how: 'lineview' };
});

test('References on: the list is checked against Crossref and OpenAlex with progress; the verdicts land in the card', async () => {
  state.settings.references = true;
  chrome.permissions = { contains: async () => true };
  const asked = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  env.ctx.fetch = async (url) => {
    const u = String(url);
    if (/docs\.google\.com/.test(u)) throw new Error('Failed to fetch');
    asked.push(u);
    await gate;
    const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    if (/openalex\.org\/works/.test(u)) return json({ results: [{ display_name: 'Interfacial activation of bacterial lipases', publication_year: 2019, authorships: [{ author: { display_name: 'J. Smith' } }] }] });
    return json({ results: [], message: { items: [] } });
  };
  T.renderHistory(); // no card from the earlier tests
  el.input.value = '/check';
  const run = T.sendMessage();
  await waitFor(() => card() && card().querySelector('.ck-progress'), 'the progress line');
  assert.match(card().querySelector('.ck-progress').textContent, /Checking 0 of 1…/);
  assert.ok(card().querySelector('.ck-progress button.ck-cancel'));
  release();
  await run;
  assert.ok(!card().querySelector('.ck-progress'));
  assert.deepStrictEqual(groupItems('reflist'), [
    '⚠️ line 13 Warning: Smith (2020). Found in OpenAlex, but year 2020 here, 2019 in OpenAlex.',
    'ℹ️ 0 of 1 entry matches Crossref or OpenAlex.',
  ]);
  assert.strictEqual(asked.length, 1);
  assert.match(asked[0], /^https:\/\/api\.openalex\.org\/works\?search=Interfacial%20activation/);
  assert.match(card()._report, /### Reference list against Crossref and OpenAlex\n\n- ⚠️ warning · line 13 · Warning: Smith \(2020\)/);
});

test('References on: Cancel in the card stops the lookups; the card says how far it got', async () => {
  state.settings.references = true;
  chrome.permissions = { contains: async () => false }; // OpenAlex removed in chrome://extensions: Crossref only, with a hint
  env.ctx.fetch = async (url, init) => {
    if (/docs\.google\.com/.test(String(url))) throw new Error('Failed to fetch');
    return new Promise((resolve, reject) => { init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); });
  };
  T.renderHistory();
  el.input.value = '/check';
  const run = T.sendMessage();
  await waitFor(() => card() && card().querySelector('button.ck-cancel'), 'the Cancel button');
  click(card().querySelector('button.ck-cancel'));
  await run;
  assert.ok(!state.busy);
  const items = groupItems('reflist');
  assert.strictEqual(items.length, 1);
  assert.match(items[0], /^ℹ️ Stopped after 0 of 1 entry; OpenAlex is not allowed, so only Crossref was searched\.$/);
  state.settings.references = false;
});

test('without the grant: Allow lookups asks Chrome from the click, then checks the list; a refusal says so and keeps the button', async () => {
  state.settings.references = false;
  const asked = [];
  let grant = false;
  chrome.permissions = { request: async (p) => { asked.push(p.origins); return grant; }, contains: async () => grant };
  const looked = [];
  env.ctx.fetch = async (url) => {
    const u = String(url);
    if (/docs\.google\.com/.test(u)) throw new Error('Failed to fetch');
    looked.push(u);
    return { ok: true, status: 200, json: async () => ({ results: [], message: { items: [] } }), text: async () => '{}' };
  };
  T.renderHistory();
  el.input.value = '/check';
  await T.sendMessage();
  await waitFor(() => card() && !state.busy, 'the report');
  assert.strictEqual(T.pendingPreviews.size, 0); // /check shows no card: the button asks
  // refused by Chrome: nothing looked up, the line says so, the button is back
  click(card().querySelector('button.ck-allow'));
  await waitFor(() => /Chrome did not allow/.test(groupItems('reflist')[0] || ''), 'the refusal');
  deq(asked, [[...T.REFERENCES_ORIGINS]]);
  assert.deepStrictEqual([looked.length, state.settings.references], [0, false]);
  assert.ok(card().querySelector('button.ck-allow:not([disabled])'));
  // granted: stored, then the list is checked
  grant = true;
  click(card().querySelector('button.ck-allow'));
  await waitFor(() => !card().querySelector('button.ck-allow') && !state.busy, 'the checked list');
  assert.deepStrictEqual([state.settings.references, env.storage.muninReferences, asked.length], [true, true, 2]);
  assert.ok(looked.some((u) => /openalex|crossref/.test(u)), looked.join('\n'));
  assert.match(groupItems('reflist').pop(), /of 1 entry matches Crossref or OpenAlex/);
  state.settings.references = false;
});

test('with the Docs API: heading styles, suggested changes and open comments; no export request', async () => {
  const P = (p, style) => (style ? { p, style } : { p });
  const items = [P('Paper', 'TITLE'), P('Methods', 'HEADING_1'), P('Plain text of the methods.'), { p: 'A suggested sentence.', suggest: { insert: [0, 1] } },
    P('Discussion', 'HEADING_1'), P('We thank the reviewers for this.')];
  await bench.fresh({ documentId: 'DOC123', title: 'Paper', tabs: [{ id: 't.0', title: 'Tab', items }], comments: [
    { id: 'c1', status: 'open', quoted: 'Plain text', text: 'Rephrase this.' }, { id: 'c2', status: 'resolved', quoted: 'Paper', text: 'Done' }] });
  state.googleConnected = true;
  const before = fake.log.length;
  T.renderHistory();
  el.input.value = '/check';
  await T.sendMessage();
  await waitFor(() => card() && !state.busy, 'the report');
  assert.match(card().querySelector('.ck-head').textContent, /· Docs API$/);
  assert.strictEqual(card().querySelector('.ck-sub'), null);
  deq(groupItems('blind').sort(), ['⚠️ line 3 Open comment: «Rephrase this.».', '⚠️ line 4 Unresolved suggested change.', '⚠️ line 6 Acknowledgement or funding line «We thank».'].sort());
  const gets = fake.log.slice(before).filter((x) => x.method === 'GET');
  assert.strictEqual(gets.filter((x) => /commentsViewMode=/.test(x.url)).length, 1);
  state.googleConnected = false;
});
