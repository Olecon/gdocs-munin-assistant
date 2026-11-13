'use strict';
// /code is Munin's own code persona: with OpenAI or Anthropic a typed "/code …" is not sent (an error, no request,
// the text stays in the input box); with Munin it runs as a persona turn.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { load } = require('./lib/sandbox');
const { sseResponse } = require('./lib/streams');
const { docBench, useProvider, send } = require('./lib/context');

let env, T, state, doc;
const errors = () => T.el.chat.children.filter((c) => c.className && c.className.includes('error')).map((c) => c.textContent || c.innerHTML);
const NOTICE = '/code works with a Munin model only. Choose one for this chat under the input box, or use /chat.';

before(async () => {
  env = await load();
  ({ T, state } = env);
  ({ doc } = docBench(env));
  doc.text = '# Doc\n\nText.\n';
});

async function fresh(prov) {
  useProvider(env, prov, prov === 'anthropic' ? { model: 'claude-opus-5-5' } : {});
  await T.createChat();
  T.el.chat.children.length = 0;
}

test('the error text', () => {
  assert.strictEqual(T.MUNIN_ONLY_NOTICE('code'), NOTICE);
  assert.strictEqual(T.commandUnavailable('chat'), '');
  assert.strictEqual(T.commandUnavailable('review'), '');
});

for (const prov of ['openai', 'anthropic']) {
  test(`${prov}: "/code x" shows the error and makes no request; the text stays in the input box`, async () => {
    await fresh(prov);
    const calls = [];
    env.ctx.fetch = async (url) => { calls.push(url); throw new Error('no network'); };
    assert.strictEqual(T.commandUnavailable('code'), 'Munin only');
    await send(env, '/code x');
    assert.deepStrictEqual(calls, []);
    assert.deepStrictEqual(errors(), [NOTICE]);
    assert.strictEqual(T.el.input.value, '/code x');
    assert.strictEqual(state.messages.length, 0);
    assert.ok(!state.busy);
    // a bare /code is refused the same way
    T.el.chat.children.length = 0;
    await send(env, '/code');
    assert.deepStrictEqual(calls, []);
    assert.deepStrictEqual(errors(), [NOTICE]);
  });
}

test('munin: "/code x" runs a persona turn', async () => {
  await fresh('munin');
  assert.strictEqual(T.commandUnavailable('code'), '');
  const pev = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  const bodies = [];
  env.ctx.fetch = async (url, init) => { bodies.push(JSON.parse(init.body)); return sseResponse(pev('token', { content: 'print(1)' }) + pev('done', { finish_reason: 'stop' })); };
  await send(env, '/code x');
  assert.strictEqual(bodies.length, 1);
  assert.strictEqual(bodies[0].persona, 'code');
  assert.strictEqual(state.messages[0]._persona, 'code');
  assert.ok(!errors().includes(NOTICE));
});
