'use strict';
// The benches' consts option (test/lib/sandbox.js withConsts): a test-time value replaces the constant's line, an
// unknown name throws instead of leaving the real delay in place.
const { test } = require('node:test');
const assert = require('node:assert');
const { load, withConsts } = require('./lib/sandbox');

test('withConsts: the top-level and the indented line get the JSON value; other lines stay', () => {
  const used = new Set();
  const src = 'const A_MS = 1000; // why\n  const B = [2000, 5000];\nconst A_MS_2 = 7;\n';
  assert.strictEqual(withConsts(src, { A_MS: 20, B: [1, 1] }, used), 'const A_MS = 20; // why\n  const B = [1,1];\nconst A_MS_2 = 7;\n');
  assert.deepStrictEqual([...used], ['A_MS', 'B']);
  assert.strictEqual(withConsts(src, { NOPE: 1 }, new Set()), src);
});

test('load({ consts }): the panel runs with the value; a name no script declares throws', async () => {
  const env = await load({ consts: { DOC_LIVE_EXPORT_SIGNAL_MS: 150, STREAM_RETRY_DELAYS_MS: [1, 1] } });
  assert.strictEqual(env.run('DOC_LIVE_EXPORT_SIGNAL_MS'), 150);
  assert.strictEqual(env.run('STREAM_RETRY_DELAYS_MS.join()'), '1,1');
  await assert.rejects(load({ consts: { NO_SUCH_DELAY_MS: 1 } }), /no "const NAME = …;" line for NO_SUCH_DELAY_MS/);
});
