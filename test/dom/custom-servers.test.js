'use strict';
// Custom servers that are not local (Yandex AI Studio and other hosted OpenAI-compatible APIs), on a real DOM: the Extra
// headers rows (sanitized, refused rows marked, at most 8, stored, sent with the model list and every chat request, the key and Content-Type winning),
// Chrome's host permission asked from Check provider after a blocked request (the gesture: request() before any await),
// the chat error for a blocked server, and a 400 naming stream_options or parallel_tool_calls: one retry without the
// field, remembered on the account.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { load, click } = require('../lib/dom-sandbox');
const { deq, waitFor } = require('../lib/sandbox');
const { sseResponse } = require('../lib/streams');

let env, T, state, document, storage, chrome;
const BASE = 'https://ai.api.cloud.yandex.net/v1';
const listResponse = (ids) => ({ ok: true, status: 200, json: async () => ({ object: 'list', data: ids.map((id) => ({ id })) }), text: async () => '' });
const errorResponse = (status, message) => ({ ok: false, status, json: async () => ({ error: { message } }), text: async () => JSON.stringify({ error: { message } }), headers: { get: () => null } });
const chatStream = (text) => sseResponse(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
const change = (input, value) => { input.value = value; input.dispatchEvent(new env.window.Event('change', { bubbles: true })); };
const row = (id) => document.querySelector(`.provider-block[data-account="${id}"]`);
const status = (id) => row(id).querySelector('.model-row + .hint').textContent;
const headerRows = (id) => [...row(id).querySelectorAll('.header-row')];
const addButton = (id) => row(id).querySelector('.header-add');
// Add header, then the name and the value typed; each field left fires change (as in Chrome).
function addHeader(id, name, value) {
  click(addButton(id));
  const r = headerRows(id).at(-1);
  change(r.querySelector('.header-name'), name);
  change(r.querySelector('.header-value'), value);
  return r;
}

before(async () => {
  env = await load({ legacySettings: false, storage: { muninAccounts: [
    { id: 'm', type: 'munin', name: 'Munin', apiKey: 'k-m' },
    { id: 'o', type: 'openai', name: 'OpenAI', apiKey: 'sk-o' },
    { id: 'ya', type: 'custom', name: 'Yandex', apiKey: 'AQVN-key', baseUrl: BASE, model: 'gpt://b1g/yandexgpt/latest' },
    { id: 'lan', type: 'custom', name: 'Lab', apiKey: '', baseUrl: 'http://10.0.0.5:8000/v1', model: 'qwen' },
  ] } });
  ({ T, state, document, storage, chrome } = env);
});
after(() => env.close());

test('headers: sanitized (names, forbidden ones, values, at most 8)', () => {
  deq(T.sanitizeHeaders({ 'OpenAI-Project': ' b1g ', Authorization: 'x', 'content-type': 'y', Host: 'h', Cookie: 'c', 'Sec-Fetch-Mode': 's',
    'Proxy-Authorization': 'p', 'bad name': 'v', 'X-Empty': '  ', 'X-Long': 'a'.repeat(600), 'X-Line': 'a\nb', 'X-Cyr': 'ключ' }),
  { 'OpenAI-Project': 'b1g', 'X-Long': 'a'.repeat(500) });
  const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`X-H${i}`, String(i)]));
  assert.strictEqual(Object.keys(T.sanitizeHeaders(many)).length, 8);
  assert.strictEqual(T.sanitizeHeaders({ Authorization: 'x' }), null);
  // the first of two names that differ only in case is kept
  deq(T.sanitizeHeaders({ 'X-A': '1', 'x-a': '2' }), { 'X-A': '1' });
  // only custom accounts keep them; omit is a list from the fixed allowlist
  const [mu, cu] = T.sanitizeAccounts([
    { id: 'a', type: 'munin', name: 'M', apiKey: 'k', headers: { 'X-A': '1' }, omit: ['stream_options'] },
    { id: 'b', type: 'custom', name: 'C', apiKey: '', baseUrl: BASE, headers: { 'X-A': '1', Cookie: 'c' }, omit: ['parallel_tool_calls', 'model', 'stream_options', 'parallel_tool_calls'] },
  ]);
  assert.ok(!('headers' in mu) && !('omit' in mu));
  deq([cu.headers, cu.omit], [{ 'X-A': '1' }, ['stream_options', 'parallel_tool_calls']]);
});

test('Extra headers: only custom rows have them; a row is stored, rechecked and sent with the model list and every chat request', async () => {
  T.openSettings();
  for (const id of ['m', 'o']) assert.strictEqual(row(id).querySelector('.account-headers'), null, id);
  const box = row('ya').querySelector('.account-headers');
  assert.strictEqual(box.querySelector('.field-caption').textContent, 'Extra headers');
  deq([headerRows('ya').length, addButton('ya').textContent, addButton('ya').disabled], [0, 'Add header', false]);
  assert.ok(!/one Name: value per line/i.test(row('ya').textContent));
  // Add header: one empty row, its name focused; nothing stored, nothing asked
  click(addButton('ya'));
  const [first] = headerRows('ya');
  deq([first.querySelector('.header-name').placeholder, first.querySelector('.header-value').placeholder], ['OpenAI-Project', '<folder ID>']);
  assert.strictEqual(document.activeElement, first.querySelector('.header-name'));
  // a stale list and mark go with the change, then the server is asked again with the header
  state.modelLists.ya = ['old'];
  const sent = [];
  env.ctx.fetch = async (url, init = {}) => {
    sent.push([url, { ...(init.headers || {}) }]);
    if (/\/models$/.test(url)) return listResponse(['gpt://b1g/yandexgpt/latest', 'gpt://b1g/yandexgpt-lite/latest']);
    throw new Error('unexpected fetch ' + url);
  };
  // the name alone is an unfinished row: not stored, not marked while the user is in it
  change(first.querySelector('.header-name'), 'OpenAI-Project');
  await new Promise((r) => setTimeout(r, 20));
  deq([sent.length, first.classList.contains('warn')], [0, false]);
  change(first.querySelector('.header-value'), ' b1g ');
  await waitFor(() => sent.length === 1 && state.modelLists.ya.length === 2, 'the check');
  deq(sent[0], [`${BASE}/models`, { 'OpenAI-Project': 'b1g', Authorization: 'Bearer AQVN-key' }]);
  deq(storage.muninAccounts.find((a) => a.id === 'ya').headers, { 'OpenAI-Project': 'b1g' });
  deq(state.modelLists.ya, ['yandexgpt/latest', 'yandexgpt-lite/latest']); // the shared prefix is stored once (model-prefix.test.js)
  // a blocked name: the row is marked and says why, not stored, nothing asked; no status line about it
  const bad = addHeader('ya', 'Authorization', 'Bearer stolen');
  await new Promise((r) => setTimeout(r, 20));
  deq([bad.classList.contains('warn'), bad.dataset.tip, sent.length, status('ya')], [true, 'This header cannot be set here', 1, '']);
  deq(storage.muninAccounts.find((a) => a.id === 'ya').headers, { 'OpenAI-Project': 'b1g' });
  assert.ok(!first.classList.contains('warn'));
  // the same value again: nothing changes, nothing is asked
  change(first.querySelector('.header-value'), 'b1g');
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(sent.length, 1);
  // a rebuilt row shows only the stored headers (the refused and the empty rows go)
  click(addButton('ya'));
  T.closeSettings(); T.openSettings();
  deq(headerRows('ya').map((r) => [r.querySelector('.header-name').value, r.querySelector('.header-value').value]), [['OpenAI-Project', 'b1g']]);
  T.closeSettings();
  // chat requests of every builder carry it; the key and Content-Type win over the account's headers
  await T.setChatModel('ya', 'gpt://b1g/yandexgpt/latest');
  const snap = T.takeSnapshot(); T.snapshotDocument(snap);
  for (const r of [T.buildRequest('edit', snap), T.buildSummaryRequest(snap, 'x'), T.chatTitleRequest(snap, 'x')]) {
    deq(r.headers, { 'OpenAI-Project': 'b1g', 'Content-Type': 'application/json', Authorization: 'Bearer AQVN-key' });
  }
  deq(T.bearerHeaders({ apiKey: 'k', headers: { Authorization: 'Bearer other', 'Content-Type': 'text/plain', 'X-A': '1' } }),
    { Authorization: 'Bearer k', 'Content-Type': 'application/json', 'X-A': '1' });
  assert.strictEqual(T.agentTarget('Yandex/gpt://b1g/yandexgpt-lite/latest', snap).cfg.headers['OpenAI-Project'], 'b1g');
  // × removes the row and the property
  T.openSettings();
  click(headerRows('ya')[0].querySelector('.header-remove'));
  assert.strictEqual(headerRows('ya').length, 0);
  await waitFor(() => !('headers' in storage.muninAccounts.find((a) => a.id === 'ya')) && sent.length === 2, 'the headers removed');
  deq(sent[1][1], { Authorization: 'Bearer AQVN-key' });
  T.closeSettings();
});

test('Extra headers: refused rows say why, a duplicate name keeps the first, at most 8 rows (Add header disabled), × frees a place', async () => {
  const sent = [];
  env.ctx.fetch = async (url, init = {}) => { sent.push({ ...(init.headers || {}) }); return listResponse(['m1']); };
  T.openSettings();
  T.toggleAccountRow('lan', true);
  const tips = [['bad name', 'v', 'Use letters, digits and dashes in the name'], ['X-Cyr', 'ключ', 'The value has characters a header cannot carry'],
    ['Sec-Fetch-Mode', 'x', 'This header cannot be set here'], ['', 'orphan', 'Add the header name']];
  for (const [n, v, tip] of tips) {
    const r = addHeader('lan', n, v);
    document.activeElement.blur();
    r.dispatchEvent(new env.window.FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    deq([r.classList.contains('warn'), r.dataset.tip], [true, tip], n);
  }
  assert.ok(!('headers' in storage.muninAccounts.find((a) => a.id === 'lan')));
  // a name with no value is marked once the row is left
  const half = addHeader('lan', 'X-Half', '');
  document.activeElement.blur();
  half.dispatchEvent(new env.window.FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
  deq([half.classList.contains('warn'), half.dataset.tip], [true, 'Add a value']);
  addHeader('lan', 'X-A', '1');
  const dup = addHeader('lan', 'x-a', '2');
  await waitFor(() => sent.length >= 1, 'the check');
  deq([dup.classList.contains('warn'), dup.dataset.tip], [true, 'This header is already set above']);
  deq(storage.muninAccounts.find((a) => a.id === 'lan').headers, { 'X-A': '1' });
  // 7 rows so far, the 8th fills the list: Add header is disabled and adds nothing
  addHeader('lan', 'X-B', '2');
  deq([headerRows('lan').length, addButton('lan').disabled], [8, true]);
  click(addButton('lan'));
  assert.strictEqual(headerRows('lan').length, 8);
  await waitFor(() => JSON.stringify(storage.muninAccounts.find((a) => a.id === 'lan').headers) === '{"X-A":"1","X-B":"2"}', 'X-B stored');
  // × on a refused row frees a place; the stored headers stay
  click(headerRows('lan')[0].querySelector('.header-remove'));
  deq([headerRows('lan').length, addButton('lan').disabled], [7, false]);
  deq(storage.muninAccounts.find((a) => a.id === 'lan').headers, { 'X-A': '1', 'X-B': '2' });
  // removing X-A lets the duplicate below take its place (its mark goes); removing the rest clears the property
  const byName = (n) => headerRows('lan').find((r) => r.querySelector('.header-name').value === n);
  click(byName('X-A').querySelector('.header-remove'));
  await waitFor(() => JSON.stringify(storage.muninAccounts.find((a) => a.id === 'lan').headers) === '{"x-a":"2","X-B":"2"}', 'x-a stored');
  assert.ok(!dup.classList.contains('warn'));
  for (const n of ['x-a', 'X-B']) click(byName(n).querySelector('.header-remove'));
  await waitFor(() => !('headers' in storage.muninAccounts.find((a) => a.id === 'lan')), 'the headers removed');
  T.closeSettings(); T.openSettings();
  assert.strictEqual(headerRows('lan').length, 0);
  T.closeSettings();
});

test('host access: a blocked model list says so; Check provider asks Chrome first (within the click), a refusal says what to do, a grant checks', async () => {
  const granted = new Set();
  const asked = [];
  let answer = false;
  chrome.permissions = {
    contains: async (p) => p.origins.every((o) => granted.has(o)),
    request: (p) => { asked.push(p.origins); if (answer) p.origins.forEach((o) => granted.add(o)); return Promise.resolve(answer); },
  };
  let fetched = 0;
  env.ctx.fetch = async (url) => {
    fetched++;
    if (!granted.has('http://10.0.0.5:8000/*')) throw new TypeError('Failed to fetch');
    if (/\/models$/.test(url)) return listResponse(['qwen']);
    throw new Error('unexpected fetch ' + url);
  };
  T.openSettings();
  T.toggleAccountRow('lan', true);
  const check = row('lan').querySelector('.account-check');
  click(check);
  await waitFor(() => /Chrome did not let/.test(status('lan')), 'the blocked status');
  assert.strictEqual(status('lan'), 'Chrome did not let the panel reach 10.0.0.5:8000. Click Check provider to allow it.');
  deq([asked.length, fetched], [0, 1]); // nothing asked up front
  // the next click asks Chrome synchronously in the click (the user gesture), before anything is awaited
  click(check);
  deq(asked, [['http://10.0.0.5:8000/*']]);
  await waitFor(() => /did not allow/.test(status('lan')), 'the refusal');
  assert.strictEqual(status('lan'), 'Chrome did not allow access to 10.0.0.5:8000. Click Check provider and choose Allow.');
  assert.strictEqual(fetched, 1);
  // asked again; granted: the check runs and the list arrives
  answer = true;
  click(check);
  assert.strictEqual(asked.length, 2);
  await waitFor(() => (state.modelLists.lan || []).length === 1 && status('lan') === '', 'the list after the grant');
  assert.ok(storage.muninAccounts.find((a) => a.id === 'lan').health.ok);
  // a later click is a plain check again (no request)
  click(check);
  await waitFor(() => fetched === 3, 'the plain check');
  assert.strictEqual(asked.length, 2);
  // a server that is down while the origin is granted: the usual message, no question
  env.ctx.fetch = async () => { throw new TypeError('Failed to fetch'); };
  click(check);
  await waitFor(() => /^Could not get the model list/.test(status('lan')), 'the plain failure');
  click(check);
  await waitFor(() => /^Could not get the model list/.test(status('lan')) && !row('lan').querySelector('.account-check').disabled, 'checked again');
  assert.strictEqual(asked.length, 2);
  T.closeSettings();
  delete chrome.permissions;
});

test('host access in the chat: a request Chrome blocks tells the user to open the settings, without retries', async () => {
  chrome.permissions = { contains: async () => false, request: async () => false };
  let tries = 0;
  env.ctx.fetch = async () => { tries++; throw new TypeError('Failed to fetch'); };
  await T.setChatModel('lan', 'qwen');
  const snap = T.takeSnapshot(); T.snapshotDocument(snap);
  const req = T.buildRequest('manual', snap);
  const err = await T.runStream(req, new env.window.AbortController().signal, snap, {}).then(() => null, (e) => e);
  assert.strictEqual(err.message, 'Chrome did not let the panel reach 10.0.0.5:8000. Open the settings and click Check provider on Lab to allow it.');
  deq([err.noAccess, tries], [true, 1]);
  // Munin's own server is in the manifest: no such check
  delete chrome.permissions;
});

test('a 400 naming parallel_tool_calls or stream_options: sent once more without it, remembered on the account; other 400s and other types are not retried', async () => {
  await T.setChatModel('ya', 'gpt://b1g/yandexgpt/latest');
  const bodies = [];
  const answers = [
    errorResponse(400, 'Unknown field: parallel_tool_calls is not supported by this model'),
    errorResponse(400, "Invalid request: 'stream_options' is not allowed"),
    chatStream('Hi.'), chatStream('Again.'),
  ];
  env.ctx.fetch = async (url, init) => { bodies.push(JSON.parse(init.body)); return answers.shift(); };
  // parallel_tool_calls comes with the Docs API writing tools; set here, as a turn with them sends it
  const withParallel = (r) => Object.assign(r, { body: { ...r.body, parallel_tool_calls: false } });
  let snap = T.takeSnapshot(); T.snapshotDocument(snap);
  const req = withParallel(T.buildRequest('edit', snap));
  assert.ok('parallel_tool_calls' in req.body && 'stream_options' in req.body);
  const r = await T.runStream(req, new env.window.AbortController().signal, snap, {});
  assert.strictEqual(r.content, 'Hi.');
  deq(bodies.map((b) => ['parallel_tool_calls' in b, 'stream_options' in b]), [[true, true], [false, true], [false, false]]);
  await waitFor(() => (storage.muninAccounts.find((a) => a.id === 'ya').omit || []).length === 2, 'the stored omission');
  deq(storage.muninAccounts.find((a) => a.id === 'ya').omit, ['stream_options', 'parallel_tool_calls']);
  // the next turn's request leaves both out from the start
  snap = T.takeSnapshot(); T.snapshotDocument(snap);
  deq(snap.cfg.omit, ['stream_options', 'parallel_tool_calls']);
  await T.runStream(withParallel(T.buildRequest('edit', snap)), new env.window.AbortController().signal, snap, {});
  deq(['parallel_tool_calls' in bodies[3], 'stream_options' in bodies[3], bodies.length], [false, false, 4]);
  // a 400 about something else: the error as it is, one request
  bodies.length = 0;
  answers.push(errorResponse(400, 'temperature must be at most 1'));
  await T.setChatModel('lan', 'qwen');
  snap = T.takeSnapshot(); T.snapshotDocument(snap);
  const e1 = await T.runStream(T.buildRequest('edit', snap), new env.window.AbortController().signal, snap, {}).then(() => null, (e) => e);
  deq([e1.status, bodies.length], [400, 1]);
  assert.ok(!storage.muninAccounts.find((a) => a.id === 'lan').omit);
  // Munin is not a custom server: its 400 is not retried
  bodies.length = 0;
  answers.push(errorResponse(400, 'parallel_tool_calls is not supported'));
  await T.setChatModel('m', 'qwen3.8-27b');
  snap = T.takeSnapshot(); T.snapshotDocument(snap);
  const e2 = await T.runStream(withParallel(T.buildRequest('edit', snap)), new env.window.AbortController().signal, snap, {}).then(() => null, (e) => e);
  deq([e2.status, bodies.length], [400, 1]);
  // a new URL forgets what the old server refused
  T.openSettings();
  T.toggleAccountRow('ya', true);
  env.ctx.fetch = async () => listResponse(['x']);
  change(row('ya').querySelector('.account-url'), 'https://llm.example.org/v1');
  await waitFor(() => storage.muninAccounts.find((a) => a.id === 'ya').baseUrl === 'https://llm.example.org/v1', 'the new URL');
  assert.ok(!('omit' in storage.muninAccounts.find((a) => a.id === 'ya')));
  T.closeSettings();
});
