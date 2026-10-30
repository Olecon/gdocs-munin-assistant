'use strict';
// The Zotero and Crossref clients (src/zotero.js) against fetch stubs: the probe and its cache (running, API setting
// off, not running, a request without the header dropped silently), the search (the header, qmode, notes and
// attachments left out), formatting (HTML to text, numeric entries), Crossref (Accept, 404), DOI parsing, listings.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load } = require('./lib/sandbox');
const { fakeZotero } = require('./lib/fake-zotero');

let env, T, z;
before(async () => {
  env = await load();
  T = env.T;
});
const fresh = () => { z = fakeZotero(); env.ctx.fetch = async (url, init) => (await z.fetch(url, init)) || (() => { throw new Error('unexpected fetch ' + url); })(); T.resetZoteroStatus(); };

test('probe: running, API off, not running; one probe per minute; every request carries Zotero-Allowed-Request', async () => {
  fresh();
  deq(await T.zoteroStatus(), { ok: true });
  assert.strictEqual(z.calls[0].url, 'http://localhost:23119/api/users/0/items?limit=1&format=keys');
  deq(z.calls[0].headers, { 'Zotero-Allowed-Request': '1', 'Zotero-API-Version': '3' });
  await T.zoteroStatus();
  assert.strictEqual(z.calls.length, 1, 'cached');
  fresh(); z.apiOn = false;
  deq(await T.zoteroStatus(), { ok: false, reason: 'off', message: 'HTTP 403' });
  fresh(); z.running = false;
  const st = await T.zoteroStatus();
  deq([st.ok, st.reason], [false, 'absent']);
});

test('a request without the header hangs like Zotero\'s silent drop: the probe gives up quickly', async () => {
  fresh();
  const t0 = Date.now();
  // the same fetch, but the header stripped
  env.ctx.fetch = async (url, init) => z.fetch(url, { ...init, headers: {} });
  const keepAlive = setInterval(() => {}, 50); // the sandbox unrefs timers of 500 ms and more
  const st = await T.zoteroStatus();
  clearInterval(keepAlive);
  deq([st.ok, st.reason, st.message], [false, 'absent', 'no answer in time']);
  assert.ok(Date.now() - t0 < 3000);
});

test('search: titleCreatorYear, at most 10 regular items (no notes), compact listing', async () => {
  fresh();
  const items = await T.zoteroSearch('smith 2020');
  deq(items.map((i) => i.key), ['ABCD1234']);
  const u = new URL(z.calls[0].url);
  deq([u.pathname, u.searchParams.get('q'), u.searchParams.get('qmode'), u.searchParams.get('format'), u.searchParams.get('include')], ['/api/users/0/items', 'smith 2020', 'titleCreatorYear', 'json', 'data']);
  assert.strictEqual(z.calls[0].headers['Zotero-Allowed-Request'], '1');
  assert.strictEqual(T.itemSummary(items[0].data), 'Smith, J.; Lee, K. (2020). Lipid rafts in membranes. Biophysical Journal. doi:10.1016/j.bpj.2020.01.001');
  assert.strictEqual(T.itemSummary({ title: 'X', creators: [{ name: 'WHO' }], publisher: 'P' }), 'WHO (n.d.). X. P.');
  deq((await T.zoteroSearch('smith')).map((i) => i.key), ['ABCD1234'], 'the note mentioning Smith is left out');
  const byDoi = await T.zoteroSearch('10.1016/j.bpj.2020.01.001', true);
  deq(byDoi.map((i) => i.key), ['ABCD1234']);
  assert.strictEqual(new URL(z.calls[z.calls.length - 1].url).searchParams.get('qmode'), 'everything');
  z.running = false;
  await assert.rejects(T.zoteroSearch('x'), /Zotero did not answer/);
});

test('format: citation and bib as plain text; numeric styles drop the entry number', async () => {
  fresh();
  const apa = await T.zoteroFormat(['ABCD1234', 'EFGH5678', 'MISSING1'], 'apa', 'en-US');
  deq(Object.keys(apa).sort(), ['ABCD1234', 'EFGH5678']);
  deq([apa.ABCD1234.citation, apa.ABCD1234.bib, apa.ABCD1234.numbered], ['(Smith & Lee, 2020)', 'Smith, J., & Lee, K. (2020). Lipid rafts in membranes. Biophysical Journal.', false]);
  const q = new URL(z.calls[0].url).searchParams;
  deq([q.get('itemKey'), q.get('include'), q.get('style'), q.get('locale')], ['ABCD1234,EFGH5678,MISSING1', 'data,citation,bib', 'apa', 'en-US']);
  const ieee = await T.zoteroFormat(['EFGH5678'], 'ieee', 'en-US');
  deq([ieee.EFGH5678.citation, ieee.EFGH5678.bib, ieee.EFGH5678.numbered], ['[1]', 'A. M. Brown, Cholesterol and order. Springer, 2018.', true]);
  assert.strictEqual(T.htmlToText('<i>A</i>&nbsp;&amp;&#8211;&#x2014;<br/>B &unknown;'), 'A &–— B &unknown;');
});

test('Crossref: metadata and bibliography through the transform route; 404 names the DOI', async () => {
  fresh();
  const meta = await T.crossrefMeta('10.1038/nphys1234');
  assert.strictEqual(z.crossrefCalls[0].url, 'https://api.crossref.org/v1/works/10.1038/nphys1234/transform');
  assert.strictEqual(z.crossrefCalls[0].accept, 'application/vnd.citationstyles.csl+json');
  assert.strictEqual(T.cslSummary(meta), 'Doe, J.; Roe, R.; Poe, P. (2019). Membrane physics. Nature Physics.');
  deq(await T.crossrefBib('10.1038/nphys1234', 'apa', 'en-US'), { bib: 'Doe, J., Roe, R., & Poe, P. (2019). Membrane physics. Nature Physics. https://doi.org/10.1038/nphys1234', numbered: false });
  assert.strictEqual(z.crossrefCalls[1].accept, 'text/x-bibliography; style=apa; locale=en-US');
  deq(await T.crossrefBib('10.1038/nphys1234', 'ieee', 'en-US'), { bib: 'J. Doe, R. Roe, and P. Poe, “Membrane physics,” Nature Physics, 2019.', numbered: true });
  await assert.rejects(T.crossrefMeta('10.9999/nope'), /Crossref does not know DOI "10\.9999\/nope"/);
  env.ctx.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(T.crossrefBib('10.1038/nphys1234', 'apa', 'en-US'), /could not reach Crossref/);
});

test('parseDoi: bare, doi: prefix, doi.org link, trailing punctuation', () => {
  assert.strictEqual(T.parseDoi('10.1038/NPHYS1234'), '10.1038/nphys1234');
  assert.strictEqual(T.parseDoi('see doi:10.1038/nphys1234.'), '10.1038/nphys1234');
  assert.strictEqual(T.parseDoi('https://doi.org/10.1126/science.169.3946.635)'), '10.1126/science.169.3946.635');
  assert.strictEqual(T.parseDoi('smith 2020'), null);
});
