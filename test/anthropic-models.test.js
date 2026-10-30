'use strict';
// The Anthropic model list (GET /v1/models, "Check models"): headers, the first page, and pagination
// with has_more / last_id (?after_id=...).
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load } = require('./lib/sandbox');

let env, T, state;
const page = (ids, hasMore) => ({ data: ids.map((id) => ({ type: 'model', id, display_name: id, created_at: '2026-01-01T00:00:00Z' })), has_more: hasMore, first_id: ids[0], last_id: ids[ids.length - 1] });
const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

// The Anthropic API with two pages of models: page 1 unless the URL asks for after_id=claude-b.
function twoPages(log) {
  return async (url, init) => {
    log.push({ url, headers: init && init.headers });
    const u = new URL(url);
    if (u.searchParams.get('after_id') === 'claude-b') return json(page(['claude-c', 'claude-opus-5-5'], false));
    return json(page(['claude-a', 'claude-b'], true));
  };
}

// Opens the settings on the Anthropic provider with a key typed in, then runs "Check models".
async function checkAnthropicModels() {
  T.openSettings();
  T.switchSettingsProvider('anthropic');
  T.el.apiKey.value = 'sk-ant-test';
  await T.checkModels();
  return state.modelLists.anthropic;
}

before(async () => {
  env = await load();
  T = env.T;
  state = env.state;
});

test('GET /v1/models: Anthropic headers, the listed IDs are offered', async () => {
  const log = [];
  env.ctx.fetch = twoPages(log);
  const ids = await checkAnthropicModels();
  assert.ok(log.length >= 1);
  assert.ok(log[0].url.startsWith('https://api.anthropic.com/v1/models'));
  deq(log[0].headers, { 'x-api-key': 'sk-ant-test', 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' });
  assert.ok(ids.includes('claude-a') && ids.includes('claude-b'));
  assert.ok(T.el.modelStatus.textContent.endsWith('is selected.'), T.el.modelStatus.textContent);
});

test('GET /v1/models follows has_more / last_id to the next page', async () => {
  const log = [];
  env.ctx.fetch = twoPages(log);
  const ids = await checkAnthropicModels();
  deq(ids, ['claude-a', 'claude-b', 'claude-c', 'claude-opus-5-5']);
  assert.strictEqual(log.length, 2);
  assert.strictEqual(new URL(log[1].url).searchParams.get('after_id'), 'claude-b');
});
