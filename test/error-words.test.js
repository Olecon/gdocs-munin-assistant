'use strict';
// errorWords (src/transport.js): what the model and the chat see of a failed request. One plain sentence that says what
// to do, without HTTP codes or the server's words; a 400 keeps a short cleaned reason (it helps the model fix its call).
// The raw text stays in rawError for the console and the chat log.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { load } = require('./lib/sandbox');

let T, PROVIDERS;
before(async () => { ({ T, PROVIDERS } = await load()); });

const resp = (status, body) => ({ ok: false, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), headers: { get: () => null } });
const google = (status, message, extra = {}) => T.docsApiError(resp(status, { error: { code: status, message, ...extra } }));
const provider = (id, status, body) => T.apiError(resp(status, body), { prov: PROVIDERS[id], cfg: { model: 'm-1' } });
const noCode = (s) => assert.ok(!/\b(?:HTTP|[45]\d\d)\b|Server:|Google:/.test(s), s);

test('Docs API errors: one plain sentence per status, the 400 reason kept', async () => {
  const cases = [
    [401, 'Request had invalid authentication credentials.', 'Sign in to Google again in the settings.'],
    [404, 'Requested entity was not found.', 'This Google account has no access to the document.'],
    [429, 'Quota exceeded for quota metric', 'Google got too many requests; wait a minute and try again.'],
    [500, 'Internal error encountered.', 'Google did not answer; try again in a moment.'],
    [503, 'The service is currently unavailable.', 'Google did not answer; try again in a moment.'],
    [400, 'Invalid requests[0].insertText: Index 9 must be less than the end index of the referenced segment, 5.',
      'The request was malformed: Invalid requests[0].insertText: Index 9 must be less than the end index of the referenced segment, 5.'],
  ];
  for (const [status, message, want] of cases) {
    const e = await google(status, message);
    assert.strictEqual(e.google, true);
    assert.ok(/HTTP|Google Docs API error/.test(e.message), 'the raw message keeps its code'); // the console, the chat log
    assert.strictEqual(T.errorWords(e), want, String(status));
    noCode(T.errorWords(e));
    assert.strictEqual(T.rawError(e), e.message);
  }
  // 403: the advice by cause, in plain words
  const denied = await google(403, 'The caller does not have permission', { status: 'PERMISSION_DENIED' });
  assert.strictEqual(T.errorWords(denied), 'The connected Google account has no access to this document, or may only view it when the request edits it. Open the document with the account connected in the settings, or ask the owner for edit access.');
  noCode(T.errorWords(denied));
  const scope = await google(403, 'Request had insufficient authentication scopes.', { status: 'PERMISSION_DENIED', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] });
  assert.ok(T.errorWords(scope).startsWith('The Google authorization lacks access to Google Docs'), T.errorWords(scope));
  // the clause form inside a sentence: no capital (unless a name), no final period
  assert.strictEqual(T.errorClause(await google(404, 'x')), 'this Google account has no access to the document');
  assert.strictEqual(T.errorClause(await google(500, 'x')), 'Google did not answer; try again in a moment');
  // a 400 without a reason, or with a JSON dump only
  assert.strictEqual(T.errorWords(await google(400, '')), 'The request was malformed.');
  const long = await google(400, 'Invalid value: ' + 'x'.repeat(400));
  assert.ok(T.errorWords(long).length <= 'The request was malformed: '.length + 201, T.errorWords(long));
});

test('network errors and our own refusals', () => {
  assert.strictEqual(T.errorWords(Object.assign(new Error('could not reach the Google Docs API (Failed to fetch).'), { network: true, google: true })), 'Google did not answer; try again in a moment.');
  assert.strictEqual(T.errorWords(Object.assign(new Error('Could not reach https://api.openai.com/v1/responses (Failed to fetch). Check your connection.'), { network: true })),
    'Could not reach the model server. Check your connection (and a VPN or proxy, if any).');
  const noAccess = Object.assign(new Error('Chrome did not let the panel reach lab.example.org. Open the settings and click Check provider on Lab to allow it.'), { network: true, noAccess: true });
  assert.strictEqual(T.errorWords(noAccess), noAccess.message);
  // a preSend refusal is our own sentence: kept, capitalized
  assert.strictEqual(T.errorWords(Object.assign(new Error('the Google Docs API failed for this message, so it is not called again now; it is tried again with the next message.'), { preSend: true })),
    'The Google Docs API failed for this message, so it is not called again now; it is tried again with the next message.');
  assert.strictEqual(T.errorWords(Object.assign(new Error('x'), { name: 'AbortError' })), 'Stopped.');
  assert.strictEqual(T.errorWords(null), 'Something went wrong; try again.');
  assert.strictEqual(T.errorClause(new Error('QUOTA_BYTES quota exceeded')), 'QUOTA_BYTES quota exceeded');
});

test('provider errors: the advice without the code and the server text', async () => {
  const key = await provider('openai', 401, { error: { message: 'Incorrect API key provided: sk-…' } });
  assert.ok(/HTTP 401/.test(key.message));
  const w = T.errorWords(key);
  assert.ok(w.startsWith('Invalid OpenAI (ChatGPT) API key. '), w);
  noCode(w);
  assert.ok(!w.includes('Incorrect API key provided'));
  const model = await provider('openai', 404, { error: { message: 'The model `m-1` does not exist' } });
  assert.strictEqual(T.errorWords(model), 'Not found: the model "m-1" is not offered. Choose another one in the model menu under the input box.');
  const rate = await provider('anthropic', 429, { error: { message: 'rate_limit_error' } });
  assert.strictEqual(T.errorWords(rate), 'Rate limit or quota exceeded. Check your Anthropic (Claude) plan, usage and billing.');
  const server = await provider('anthropic', 529, { error: { type: 'overloaded_error', message: 'Overloaded' } });
  assert.strictEqual(T.errorWords(server), 'The model server did not answer; try again in a moment.');
  const bad = await provider('anthropic', 400, { error: { type: 'invalid_request_error', message: 'tools.0.name: String should match pattern' } });
  assert.strictEqual(T.errorWords(bad), 'The request was malformed: tools.0.name: String should match pattern.');
  const ctx = await provider('openai', 400, { error: { message: 'This model\'s maximum context length is 128000 tokens' } });
  const cw = T.errorWords(ctx);
  assert.ok(cw.startsWith('The request does not fit into the model\'s context window. The document is too large'), cw);
  noCode(cw);
  const quota = await provider('munin', 429, { error: 'quota' });
  noCode(T.errorWords(quota));
  assert.ok(T.errorWords(quota).startsWith('The monthly token quota of this Munin API key is used up'), T.errorWords(quota));
});
