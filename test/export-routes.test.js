'use strict';
// The document export without the Docs API (readExport, fetchDocTextFromPanel, fetchDocText): the panel's own
// export first and the content script's GET_DOC_TEXT as the fallback, the memory of a route that failed with a
// network error, an empty Markdown export, HTTP 429 (waits, Retry-After, the rate-limit message, no format=txt
// after a 429), Stop during a wait and the turn's notice.
const { test } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab } = require('./lib/sandbox');
const { sseResponse, textRound } = require('./lib/streams');

const MD = '# Title\n\nBody \\- text.\n';
const resp = (status, text = '', headers = {}) => ({
  ok: status >= 200 && status < 300, status, text: async () => text,
  headers: { get: (k) => headers[String(k).toLowerCase()] || null },
});

// A panel on DOC123 (tab 7). opts.panel(format, n) answers the panel's export requests (a response, or throws);
// opts.tab(n) answers GET_DOC_TEXT. b.log lists 'panel md', 'panel txt', 'tab' and 'sleep <ms>' in order.
async function bench({ panel, tab } = {}) {
  const env = await load();
  const { T, state, chrome, ctx } = env;
  const docTab = installDocTab(env);
  const b = { env, T, state, ctx, tab: docTab, log: [], bodies: [] };
  let np = 0;
  let nt = 0;
  chrome.tabs.sendMessage = async (id, msg) => {
    if (msg.type === 'GET_DOC_TEXT') { b.log.push('tab'); return tab ? tab(++nt) : { ok: true, text: 'From the tab.\n', format: 'markdown', requests: 1, title: 'My Doc' }; }
    if (msg.type === 'GET_SELECTION') return { ok: true, text: '' };
    return { ok: true, title: 'My Doc' };
  };
  ctx.fetch = async (url, init = {}) => {
    const m = /\/document\/d\/DOC123\/export\?format=(md|txt)/.exec(url);
    if (m) { b.log.push(`panel ${m[1]}`); b.urls = [...(b.urls || []), url]; return panel ? panel(m[1], ++np, init) : resp(200, MD); }
    if (url.endsWith('/messages')) { b.bodies.push(JSON.parse(init.body)); return sseResponse(textRound('Answer.')); }
    throw new Error('unexpected fetch ' + url);
  };
  b.realSleep = ctx.exportSleep;
  ctx.exportSleep = async (ms) => { b.log.push(`sleep ${ms}`); };
  b.read = () => T.readExport(docTab);
  return b;
}

test('the panel\'s own export is the primary route; the content script is not asked when it works', async () => {
  const b = await bench();
  const r = await b.read();
  deq(r, { text: '# Title\n\nBody - text.\n', format: 'markdown', via: 'panel' });
  deq(b.log, ['panel md']);
});

test('the panel\'s export keeps authuser from the tab URL', async () => {
  const b = await bench();
  b.tab.url = 'https://docs.google.com/document/u/2/d/DOC123/edit';
  await b.read();
  deq(b.urls, ['https://docs.google.com/document/d/DOC123/export?format=md&authuser=2']);
});

test('the panel\'s export fails (HTTP 403): the content script delivers, the panel\'s error is reported', async () => {
  const titles = [];
  const b = await bench({ panel: () => resp(403, 'Forbidden') });
  const r = await b.T.readExport(b.tab, (t) => titles.push(t));
  deq(r, { text: 'From the tab.\n', format: 'markdown', via: 'tab', panelError: 'HTTP 403' });
  deq(b.log, ['panel md', 'panel txt', 'tab']);
  deq(titles, ['My Doc']);
});

test('a route that failed with a network error is skipped for the rest of the session in that tab', async () => {
  // the content script's fetch fails (a cross-origin redirect): tried once, then skipped
  let panelOk = false;
  const b = await bench({ panel: () => (panelOk ? resp(200, MD) : resp(500, 'Error')), tab: () => ({ ok: false, error: 'Failed to fetch', network: true, requests: 1 }) });
  await assert.rejects(b.read(), { message: 'Could not get the document text (HTTP 500; Failed to fetch).' });
  deq(b.log, ['panel md', 'panel txt', 'tab']);
  b.log.length = 0;
  await assert.rejects(b.read(), { message: 'Could not get the document text (HTTP 500).' }); // the content script is not asked again
  deq(b.log, ['panel md', 'panel txt']);
  b.log.length = 0;
  panelOk = true;
  const r = await b.read();
  deq([r.via, r.tabError], ['panel', 'skipped: it failed earlier with a network error (Failed to fetch)']);
  deq(b.log, ['panel md']);
  // another tab (or a reloaded panel) starts with both routes
  b.tab.id = 8;
  b.env.chrome.tabs.get = async () => b.tab;
  b.log.length = 0;
  panelOk = false;
  await assert.rejects(b.read());
  deq(b.log, ['panel md', 'panel txt', 'tab']);

  // the panel's fetch fails with a network error: no format=txt, the content script delivers, and from then
  // on only the content script is asked
  const c = await bench({ panel: () => { throw new TypeError('Failed to fetch'); } });
  let r2 = await c.read();
  deq([r2.via, r2.panelError], ['tab', 'Failed to fetch']);
  deq(c.log, ['panel md', 'tab']);
  c.log.length = 0;
  r2 = await c.read();
  deq([r2.via, r2.panelError], ['tab', 'skipped: it failed earlier with a network error (Failed to fetch)']);
  deq(c.log, ['tab']);
});

test('both routes failed with a network error: both are tried again (one at a time), and a success clears the mark', async () => {
  let online = false;
  const b = await bench({
    panel: () => { if (!online) throw new TypeError('Failed to fetch'); return resp(200, MD); },
    tab: () => ({ ok: false, error: 'Failed to fetch', network: true }),
  });
  await assert.rejects(b.read(), /Failed to fetch; Failed to fetch/);
  await assert.rejects(b.read(), /Failed to fetch; Failed to fetch/);
  deq(b.log, ['panel md', 'tab', 'panel md', 'tab']);
  online = true;
  b.log.length = 0;
  assert.strictEqual((await b.read()).via, 'panel');
  assert.strictEqual((await b.read()).via, 'panel');
  deq(b.log, ['panel md', 'panel md']);
});

test('an empty Markdown export (HTTP 200) is an empty document: no format=txt request', async () => {
  const b = await bench({ panel: () => resp(200, '') });
  deq(await b.read(), { text: '', format: 'markdown', via: 'panel' });
  deq(b.log, ['panel md']);
});

test('HTTP 429: waits 2 s, then 5 s, and retries within the same read', async () => {
  const b = await bench({ panel: (f, n) => (n < 3 ? resp(429, 'Too many') : resp(200, MD)) });
  const r = await b.read();
  assert.strictEqual(r.via, 'panel');
  deq(b.log, ['panel md', 'sleep 2000', 'panel md', 'sleep 5000', 'panel md']);
});

test('HTTP 429 with Retry-After: that wait instead; one longer than 30 s is not waited for', async () => {
  const b = await bench({ panel: (f, n) => (n === 1 ? resp(429, '', { 'retry-after': '7' }) : resp(200, MD)) });
  await b.read();
  deq(b.log, ['panel md', 'sleep 7000', 'panel md']);
  const c = await bench({ panel: () => resp(429, '', { 'retry-after': '120' }) });
  await assert.rejects(c.read(), { message: 'Could not get the document text: the Google export is rate-limited (HTTP 429); wait a minute and try again.' });
  deq(c.log, ['panel md']);
});

test('HTTP 429 three times: the rate-limit error, no format=txt and no content-script request', async () => {
  const b = await bench({ panel: () => resp(429, 'Too many') });
  await assert.rejects(b.read(), { message: 'Could not get the document text: the Google export is rate-limited (HTTP 429); wait a minute and try again.' });
  deq(b.log, ['panel md', 'sleep 2000', 'panel md', 'sleep 5000', 'panel md']);
});

test('HTTP 429 from the content script\'s export: the same waits and retries', async () => {
  const b = await bench({
    panel: () => resp(403, 'Forbidden'),
    tab: (n) => (n === 1 ? { ok: false, error: 'Document export: HTTP 429', status: 429, retryAfter: '1', requests: 1 } : { ok: true, text: 'Tab text', format: 'text', requests: 1 }),
  });
  const r = await b.read();
  deq([r.via, r.text, r.format], ['tab', 'Tab text', 'text']);
  deq(b.log, ['panel md', 'panel txt', 'tab', 'sleep 1000', 'tab']);
});

test('Stop during a 429 wait ends the read at once with an AbortError', async () => {
  const b = await bench({ panel: () => resp(429, 'Too many') });
  b.ctx.exportSleep = b.realSleep; // the real, abortable wait (2 s)
  const ac = new AbortController();
  const t0 = Date.now();
  const p = b.T.readExport(b.tab, () => {}, { signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(p, { name: 'AbortError' });
  assert.ok(Date.now() - t0 < 1000);
});

test('a turn on a rate-limited export: the notice says so and the answer still comes', async () => {
  const b = await bench({ panel: () => resp(429, 'Too many') });
  const { T, state } = b;
  state.settings.provider = 'anthropic';
  Object.assign(state.settings.providers.anthropic, { apiKey: 'sk-ant-x', model: 'claude-opus-5-5' });
  await T.refreshContext({ force: true });
  b.log.length = 0;
  T.el.chat.children.length = 0;
  T.el.input.value = 'Hello';
  await T.sendMessage();
  deq(b.log, ['panel md', 'sleep 2000', 'panel md', 'sleep 5000', 'panel md']);
  const notices = T.el.chat.children.filter((c) => c && c.className && String(c.className).includes('notice')).map((c) => c.innerHTML);
  assert.ok(notices.some((t) => t === 'Could not get the document text: the Google export is rate-limited (HTTP 429); wait a minute and try again. Answering without the document context.'), notices.join(' | '));
  assert.strictEqual(b.bodies.length, 1);
});
