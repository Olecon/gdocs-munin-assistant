'use strict';
// The theme and the system preference (prefers-color-scheme through a matchMedia stub with "change"
// events): followed until the user picks a theme; a stored theme wins over the system.
const { test } = require('node:test');
const assert = require('node:assert');
const { load, click, tick } = require('./lib/dom-sandbox');

const theme = (env) => env.document.documentElement.getAttribute('data-theme');
const logo = (env) => env.el.brandLogo.getAttribute('src');

async function withPanel(opts, fn) {
  const env = await load(opts);
  try { await fn(env); } finally { env.close(); }
}

test('no stored theme: the system preference is applied and followed live', () => withPanel({ light: true }, async (env) => {
  assert.ok(env.media.queries.some((q) => q.media === '(prefers-color-scheme: light)'));
  assert.strictEqual(theme(env), 'light');
  assert.strictEqual(logo(env), 'icons/icon48-light.png');
  assert.strictEqual(env.state.themeFollowsSystem, true);
  env.media.set(false);
  assert.strictEqual(theme(env), 'dark');
  assert.strictEqual(logo(env), 'icons/icon48-dark.png');
  env.media.set(true);
  assert.strictEqual(theme(env), 'light');
  assert.ok(!('muninTheme' in env.storage)); // following the system stores nothing
}));

test('choosing a theme stops following the system and is stored', () => withPanel({ light: false }, async (env) => {
  assert.strictEqual(theme(env), 'dark');
  click(env.document.getElementById('themeBtn'));
  assert.strictEqual(theme(env), 'light');
  await tick(5);
  assert.strictEqual(env.storage.muninTheme, 'light');
  assert.strictEqual(env.state.themeFollowsSystem, false);
  env.media.set(false); // the system changes: the choice stays
  assert.strictEqual(theme(env), 'light');
  env.media.set(true);
  click(env.document.getElementById('themeBtn'));
  env.media.set(false);
  assert.strictEqual(theme(env), 'dark');
  await tick(5);
  assert.strictEqual(env.storage.muninTheme, 'dark');
}));

test('a stored theme wins over the system on load', async () => {
  await withPanel({ light: true, storage: { muninTheme: 'dark' } }, async (env) => {
    assert.strictEqual(theme(env), 'dark');
    assert.strictEqual(env.state.themeFollowsSystem, false);
    env.media.set(false); env.media.set(true);
    assert.strictEqual(theme(env), 'dark');
  });
  await withPanel({ light: false, storage: { muninTheme: 'light' } }, async (env) => {
    assert.strictEqual(theme(env), 'light');
    assert.strictEqual(logo(env), 'icons/icon48-light.png');
  });
  // an unknown stored value counts as no choice
  await withPanel({ light: true, storage: { muninTheme: 'sepia' } }, async (env) => {
    assert.strictEqual(theme(env), 'light');
    assert.strictEqual(env.state.themeFollowsSystem, true);
    env.media.set(false);
    assert.strictEqual(theme(env), 'dark');
  });
});

// The light tokens are written twice in sidepanel.css (CSS cannot share one block between a selector and a media
// query; light-dark() needs a newer Chrome than the manifest's minimum): the two blocks must not drift apart.
test('sidepanel.css: the light tokens of [data-theme="light"] and of the light system theme are identical', () => {
  const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'sidepanel.css'), 'utf8');
  const block = (re) => { const m = re.exec(css); assert.ok(m, String(re)); return m[1].split(';').map((d) => d.trim()).filter(Boolean); };
  const chosen = block(/:root\[data-theme="light"\] \{([^}]*)\}/);
  const system = block(/@media \(prefers-color-scheme: light\) \{\s*:root:not\(\[data-theme="dark"\]\) \{([^}]*)\}/);
  assert.ok(chosen.length > 20);
  assert.deepStrictEqual(system, chosen);
});

// The panel always animates: no rule follows prefers-reduced-motion or a data-motion attribute.
test('sidepanel.css: no reduced-motion or data-motion rules', () => {
  const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'sidepanel.css'), 'utf8');
  assert.ok(!/prefers-reduced-motion/.test(css));
  assert.ok(!/data-motion/.test(css));
});
