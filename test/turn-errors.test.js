'use strict';
// A turn that fails while it prepares (before the first request) still ends: the panel is idle again.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { load } = require('./lib/sandbox');
const { textRound } = require('./lib/streams');
const { docBench, recordFetch, useProvider, send } = require('./lib/context');

let env, T, state, doc;
before(async () => {
  env = await load();
  T = env.T;
  state = env.state;
  ({ doc } = docBench(env));
  await T.refreshContext({ force: true });
});

test('an error while the turn context is built: the panel is not left busy, the error is shown', async () => {
  useProvider(env, 'anthropic');
  doc.text = '# My Doc\n\nIntro.'; doc.selection = '';
  // The turn context fails to build. Registry callbacks (offer, docNote) are guarded and skipped, so the failure is
  // injected into buildTurnContext itself: a global of the panel's shared scope (env.ctx is the vm context; the
  // turn looks the name up at call time).
  const original = env.ctx.buildTurnContext;
  let calls = 0;
  env.ctx.buildTurnContext = (...args) => { if (++calls === 1) throw new Error('context failed'); return original(...args); };
  const bodies = recordFetch(env, [textRound('One.')]);
  try {
    await send(env, 'hello');
  } finally {
    env.ctx.buildTurnContext = original;
  }
  assert.strictEqual(state.busy, false);
  assert.strictEqual(state.abort, null);
  assert.strictEqual(bodies.length, 0);
  assert.ok(T.el.chat.children.some((n) => /context failed/.test(n.innerHTML || n.textContent || '')), 'the error is in the chat');
  // the next message works
  await send(env, 'again');
  assert.strictEqual(bodies.length, 1);
  assert.strictEqual(state.busy, false);
});

test('a registered docNote that throws is left out of the turn context; the turn goes on', async () => {
  useProvider(env, 'anthropic');
  doc.text = '# My Doc\n\nIntro.'; doc.selection = '';
  T.registerTools([{ type: 'function', function: { name: 'note_tool', description: 'x', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } } }],
    { offer: () => true, run: () => 'ok', reading: true, docNote: () => { throw new Error('note failed'); } });
  const bodies = recordFetch(env, [textRound('One.')]);
  try {
    await send(env, 'with a note');
  } finally {
    T.EXTRA_TOOLS.pop();
  }
  assert.strictEqual(bodies.length, 1);
  assert.ok(state.messages[state.messages.length - 2]._context.startsWith('<document title='));
  assert.strictEqual(state.busy, false);
});
