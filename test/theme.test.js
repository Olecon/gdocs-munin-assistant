'use strict';
// Light / dark theme: the default, the toggle and the stored choice.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { load } = require('./lib/sandbox');

let env, T, state, storage, document;

before(async () => {
  env = await load();
  T = env.T;
  state = env.state;
  storage = env.storage;
  document = env.document;
});

test('theme: dark by default, the toggle switches and persists, a stored theme is loaded', async () => {
  // --- light / dark theme: dark by default (nothing stored, no matchMedia), the toggle persists, a stored theme is read back
  const root = document.documentElement;
  assert.strictEqual(root.dataset.theme, 'dark'); // applied by init()
  assert.strictEqual(T.el.brandLogo.src, 'icons/icon48-dark.png');
  assert.strictEqual(T.THEME_KEY, 'muninTheme'); assert.ok(!('muninTheme' in storage));
  await T.toggleTheme();
  assert.strictEqual(root.dataset.theme, 'light'); assert.strictEqual(storage.muninTheme, 'light');
  assert.strictEqual(T.el.brandLogo.src, 'icons/icon48-light.png'); assert.strictEqual(state.themeFollowsSystem, false);
  await T.toggleTheme();
  assert.strictEqual(root.dataset.theme, 'dark'); assert.strictEqual(storage.muninTheme, 'dark');
  T.applyTheme('light'); root.dataset.theme = 'dark';
  storage.muninTheme = 'light'; await T.loadTheme();
  assert.strictEqual(root.dataset.theme, 'light'); assert.strictEqual(state.themeFollowsSystem, false);
  delete storage.muninTheme; await T.loadTheme();
  assert.strictEqual(root.dataset.theme, 'dark'); assert.strictEqual(state.themeFollowsSystem, true);
  storage.muninTheme = 'bogus'; await T.loadTheme(); assert.strictEqual(root.dataset.theme, 'dark');
  delete storage.muninTheme;
});
