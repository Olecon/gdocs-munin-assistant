'use strict';
// The panel always animates (jsdom): no Animations setting, no data-motion attribute; a stored muninMotion is deleted.
const { test } = require('node:test');
const assert = require('node:assert');
const { load } = require('../lib/dom-sandbox');

test('no Animations setting: a stored muninMotion sets no data-motion and the settings have no select', async () => {
  const env = await load({ storage: { muninMotion: 'off' } });
  try {
    assert.strictEqual(env.document.documentElement.getAttribute('data-motion'), null);
    assert.strictEqual(env.document.getElementById('motionSelect'), null);
    assert.ok(!('muninMotion' in env.storage));
  } finally { env.close(); }
});
