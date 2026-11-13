'use strict';
// Advanced in a provider row (src/settings.js advancedField), on a real DOM: folded by default and remembered while the
// panel lives, the fields belong to the account (every model; the Models dropdown does not change them), the placeholders
// show the defaults, a field left stores its value (empty: the default), a value out of range is marked and not stored.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { load, click } = require('../lib/dom-sandbox');
const { deq } = require('../lib/sandbox');

let env, T, state, document, storage;
const change = (input, value) => { input.value = value; input.dispatchEvent(new env.window.Event('change', { bubbles: true })); };
const row = (id) => document.querySelector(`.provider-block[data-account="${id}"]`);
const q = (id, sel) => row(id).querySelector(sel);
const stored = (id) => storage.muninAccounts.find((a) => a.id === id).params;
const settle = () => new Promise((r) => setTimeout(r, 0));

before(async () => {
  env = await load({ legacySettings: false, storage: { muninAccounts: [
    { id: 'm', type: 'munin', name: 'Munin', apiKey: 'k-m' },
    { id: 'o', type: 'openai', name: 'OpenAI', apiKey: 'sk-o', model: 'gpt-6.1-sol' },
    { id: 'c', type: 'custom', name: 'Lab', apiKey: '', baseUrl: 'http://localhost:8080/v1', model: 'qwen', limits: { qwen: { context: 16384, reply: 2048 } } },
  ] } });
  ({ T, state, document, storage } = env);
  state.modelLists = { m: ['qwen3.8-27b'], o: ['gpt-4.1', 'gpt-6.1-sol'], c: ['qwen'] };
});
after(() => env.close());

test('Advanced: below Check provider, folded by default, the open state kept when the settings reopen', () => {
  T.openSettings();
  for (const id of ['m', 'o', 'c']) T.toggleAccountRow(id, true);
  const toggle = q('o', '.account-advanced-toggle');
  assert.strictEqual(toggle.textContent, 'Advanced');
  assert.strictEqual(q('o', '.model-row').nextElementSibling.nextElementSibling, toggle); // after the models and their status line
  assert.ok(q('o', '.account-advanced').classList.contains('hidden'));
  assert.strictEqual(toggle.getAttribute('aria-expanded'), 'false');
  click(toggle);
  assert.ok(!q('o', '.account-advanced').classList.contains('hidden'));
  assert.strictEqual(toggle.getAttribute('aria-expanded'), 'true');
  T.closeSettings();
  T.openSettings();
  assert.ok(!q('o', '.account-advanced').classList.contains('hidden'), 'remembered');
  assert.ok(q('m', '.account-advanced').classList.contains('hidden'), 'per row');
});

test('the fields belong to the account: no model caption, the defaults as placeholders, the temperature always enabled, no hint (a refused temperature is not sent, silently)', () => {
  assert.strictEqual(q('o', '.account-advanced .field-caption'), null);
  // the dropdown shows the chat's model on the chat's account (Munin here: the first with a key), "—" on the others
  deq([q('o', '.account-models').value, q('o', '.account-models').options[0].textContent, q('m', '.account-models').value], ['', '—', 'qwen3.8-27b'],
    'the dropdown shows the chat\'s model on its account, else "—" (no longer a plain list showing its first model)');
  deq([q('o', '.account-max-tokens').placeholder, q('o', '.account-temperature').placeholder, q('o', '.account-temperature').disabled], ['32000', 'server default', false]);
  assert.ok(q('o', '.account-advanced .hint').classList.contains('hidden'), 'no hint for a model that refuses a temperature');
  deq([q('m', '.account-max-tokens').placeholder, q('m', '.account-temperature').placeholder], ['8192', 'default']);
  assert.ok(q('m', '.account-advanced .hint').classList.contains('hidden'));
  assert.strictEqual(q('c', '.account-max-tokens').placeholder, '2048'); // the server's own reply limit
});

test('a field left stores its value for the account; the Models dropdown does not change the fields; empty clears it; out of range is marked, not stored', async () => {
  change(q('o', '.account-max-tokens'), '2048');
  await settle();
  change(q('o', '.account-temperature'), '0.35');
  await settle();
  deq(stored('o'), { maxTokens: 2048, temperature: 0.35 });
  change(q('o', '.account-models'), 'gpt-6.1-sol');
  deq([q('o', '.account-max-tokens').value, q('o', '.account-temperature').value], ['2048', '0.35']);
  // refused values
  change(q('o', '.account-max-tokens'), '12.5');
  await settle();
  assert.ok(q('o', '.account-max-tokens').classList.contains('warn'));
  assert.strictEqual(q('o', '.account-advanced .hint').textContent, 'Enter a whole number above 0, or leave it empty for the default.');
  change(q('o', '.account-temperature'), '3');
  await settle();
  assert.strictEqual(q('o', '.account-advanced .hint').textContent, 'Enter a number from 0 to 2, or leave it empty for the default.');
  deq(stored('o'), { maxTokens: 2048, temperature: 0.35 });
  // 0 is a temperature
  change(q('o', '.account-temperature'), '0');
  await settle();
  deq(stored('o'), { maxTokens: 2048, temperature: 0 });
  // empty fields: the defaults, nothing stored
  change(q('o', '.account-max-tokens'), '');
  await settle();
  change(q('o', '.account-temperature'), '');
  await settle();
  assert.strictEqual(stored('o'), undefined);
  // a value above half the window is used capped, silently; a stored value clears the validation message
  change(q('m', '.account-max-tokens'), '0');
  await settle();
  assert.ok(!q('m', '.account-advanced .hint').classList.contains('hidden'));
  change(q('m', '.account-max-tokens'), '50000');
  await settle();
  assert.ok(q('m', '.account-advanced .hint').classList.contains('hidden'));
  assert.strictEqual(T.providerFor(T.accountById('m'), 'qwen3.8-27b').maxTokens, 32768);
});

test('a custom server\'s URL change keeps the params (the user\'s choice)', async () => {
  change(q('c', '.account-max-tokens'), '1024');
  await settle();
  env.ctx.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'qwen' }] }), text: async () => '' });
  change(q('c', '.account-url'), 'http://localhost:9090/v1');
  await settle(); await settle();
  deq(stored('c'), { maxTokens: 1024 });
});
