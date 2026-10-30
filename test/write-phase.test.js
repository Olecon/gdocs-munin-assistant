'use strict';
// The two phases of a Docs API write on its pending action-log row (docs-write.js writePhase, snap.onWritePhase set by
// the tool loop): 'writing' while the batchUpdate is sent, 'verifying' while the re-read checks it; per batch for
// commitSequence; a turn re-renders the live bubble on each change, and the finished row carries no phase.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, installIdentity } = require('./lib/sandbox');
const { docsBench } = require('./lib/fake-docs');
const { sseResponse, tu, msgStart, stopTool, textRound } = require('./lib/streams');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, fresh, exec, routeDocs;

before(async () => {
  env = await load();
  T = env.T;
  state = env.state;
  const ident = installIdentity(env);
  ({ fresh, exec, routeDocs } = docsBench(env, ident, ref));
  installDocTab(env);
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic'; state.googleConnected = true;
});

// Every Docs API request with the phase reported last before it.
function watchPhases() {
  const seen = [];
  let phase = null;
  as.onWritePhase = (p) => { phase = p; seen.push(p); };
  const real = fake.fetch;
  const calls = [];
  fake.fetch = async (url, init = {}) => { calls.push([init.method || 'GET', phase]); return real(url, init); };
  return { seen, calls };
}

test('commitEdit: writing for the batchUpdate, verifying for the re-read', async () => {
  await fresh();
  const { seen, calls } = watchPhases();
  const r = await exec('replace_text', { old_text: 'Alpha beta gamma.', new_text: 'Alpha beta epsilon.' });
  assert.ok(r._ok, r.content);
  deq(seen, ['writing', 'verifying']);
  deq(calls, [['POST', 'writing'], ['GET', 'verifying']]);
});

test('a failed batchUpdate never reports verifying; no hook is harmless; a throwing hook does not break the write', async () => {
  await fresh();
  const { seen } = watchPhases();
  fake.failNext = { status: 400, message: 'Invalid requests[0]' };
  const r = await exec('replace_text', { old_text: 'Alpha beta gamma.', new_text: 'x' });
  assert.ok(!r._ok);
  deq(seen, ['writing']);
  await fresh();
  as.onWritePhase = null;
  assert.ok((await exec('replace_text', { old_text: 'Alpha beta gamma.', new_text: 'y' }))._ok);
  as.onWritePhase = () => { throw new Error('boom'); };
  assert.ok((await exec('replace_text', { old_text: 'Alpha beta delta.', new_text: 'z' }))._ok);
});

test('commitSequence: writing and verifying for each batch; the final finishEdit adds no read of its own', async () => {
  await fresh({ documentId: 'DOC123', title: 'S', tabs: [{ id: 't.0', title: 'Main', items: [{ p: 'Body text' }] }] });
  const { seen, calls } = watchPhases();
  const plan = { region: [1, 1], journal: { kind: 'requests', inverse: [] }, title: 'Inserted', affected: () => [1, 1] };
  const res = await T.commitSequence(as, plan, 's1', [(m) => ({ requests: [T.reqInsert(m, 1, 'A')] }), (m) => ({ requests: [T.reqInsert(m, 1, 'B')] })]);
  assert.ok(!res.fail);
  await T.finishEdit(as, plan, 's1', res.model);
  deq(seen, ['writing', 'verifying', 'writing', 'verifying']);
  deq(calls, [['POST', 'writing'], ['GET', 'verifying'], ['POST', 'writing'], ['GET', 'verifying']]);
});

test('a turn: the pending row shows writing, then verifying, each painted; the finished row has no phase', async () => {
  await fresh();
  Object.assign(state.settings.providers.anthropic, { apiKey: 'sk-ant-x', model: 'claude-opus-5-5', baseUrl: 'https://api.anthropic.com/v1' });
  const rounds = [msgStart + tu(0, 'toolu_w', 'replace_text', { old_text: 'Alpha beta gamma.', new_text: 'Alpha beta epsilon.' }) + stopTool, textRound('Done.')];
  let n = 0;
  const atRead = []; // the newest painted row of replace_text while the verifying re-read is in flight
  const paints = [];
  env.ctx.__paints = paints;
  env.run('(() => { const orig = updateAssistantBubble; updateAssistantBubble = function (b, o) { __paints.push((o.activity || []).filter((a) => a && a.log).map((a) => ({ status: a.status, phase: a.phase }))); return orig(b, o); }; globalThis.__restorePaint = () => { updateAssistantBubble = orig; }; })()');
  const docs = routeDocs(async () => sseResponse(rounds[n++]));
  let posted = false;
  env.ctx.fetch = async (url, init = {}) => {
    if (/docs\.googleapis/.test(url) && (init.method || 'GET') === 'POST') posted = true;
    else if (posted && /docs\.googleapis/.test(url)) { posted = false; atRead.push(paints[paints.length - 1]); }
    return docs(url, init);
  };
  try {
    const s = T.takeSnapshot(); T.snapshotDocument(s);
    const messages = [{ role: 'user', content: 'Change gamma.' }];
    await T.toolLoop('edit', s, new AbortController().signal, { messages, save: async () => {} });
    deq(atRead, [[{ status: 'pending', phase: 'verifying' }]]);
    const phases = paints.map((p) => p.length && p[0].phase);
    const order = phases.filter((p, i) => p && p !== phases[i - 1]);
    deq(order, ['writing', 'verifying']);
    deq(paints.filter((p) => p.length).pop(), [{ status: 'ok', phase: undefined }]);
    assert.strictEqual(s.onWritePhase, null); // the hook goes with the call
    const r = messages.find((m) => m.role === 'tool');
    assert.ok(r._ok && /^Done: /.test(r.content), r.content);
  } finally {
    env.run('__restorePaint()');
  }
});
