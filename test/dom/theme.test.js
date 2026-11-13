'use strict';
// Theme switch: the hover transitions are off for a moment (html.theme-switching) so every colour changes in one
// frame, and the brand icon swaps with the colours (both PNGs preloaded).
const test = require('node:test');
const assert = require('node:assert');
const { load, tick } = require('../lib/dom-sandbox');

test('theme switch: the transition-free class appears for a moment and the brand icon follows', async () => {
  const env = await load();
  const { T, el, document } = env;
  const root = document.documentElement;
  T.applyTheme('dark');
  assert.strictEqual(root.dataset.theme, 'dark');
  assert.ok(!root.classList.contains('theme-switching'), 'no class when the theme did not change');
  T.applyTheme('light');
  assert.strictEqual(root.dataset.theme, 'light');
  assert.ok(root.classList.contains('theme-switching'), 'the class during the switch');
  assert.ok(el.brandLogo.src.endsWith('icons/icon48-light.png'));
  await tick(400);
  assert.ok(!root.classList.contains('theme-switching'), 'the class is gone after the switch');
  T.applyTheme('light');
  assert.ok(!root.classList.contains('theme-switching'), 'same theme again: no class');
  env.close();
});
