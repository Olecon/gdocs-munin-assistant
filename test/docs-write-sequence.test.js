'use strict';
// commitSequence after a later batch fails: a clear refusal rolls back the earlier steps; an unclear failure (the
// connection failed or Google answered 5xx) re-reads the document once and rolls back the failed batch too when it
// arrived; a re-read that fails rolls nothing back and says the edit may be partly applied.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, installIdentity } = require('./lib/sandbox');
const { docsBench } = require('./lib/fake-docs');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let T, state, fresh;

before(async () => {
  const env = await load();
  T = env.T;
  state = env.state;
  const ident = installIdentity(env);
  ({ fresh } = docsBench(env, ident, ref));
  installDocTab(env);
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic'; state.googleConnected = true;
});

const spec = () => ({ documentId: 'DOC123', title: 'S', tabs: [{ id: 't.0', title: 'Main', items: [{ p: 'Body text' }] }] });
const plan = () => ({ region: [1, 1], journal: {} });
const del = (m) => [T.reqDelete(m, 1, 2)];
// Two steps, each inserting one letter at the start with a rollback that deletes it; the second batch fails with fail.
const steps = (fail) => [
  (m) => ({ requests: [T.reqInsert(m, 1, 'A')], rollback: del }),
  (m) => { fake.failNext = fail; return { requests: [T.reqInsert(m, 1, 'B')], rollback: del }; },
];
const posts = () => fake.log.filter((x) => x.method === 'POST').map((x) => x.body.requests);
const gets = () => fake.log.filter((x) => x.method === 'GET').length;
const DEL = [{ deleteContentRange: { range: { startIndex: 1, endIndex: 2, tabId: 't.0' } } }];

test('unclear failure, the batch arrived: it is rolled back too, on the one re-read', async () => {
  await fresh(spec());
  const g = gets();
  const r = await T.commitSequence(as, plan(), 'q1', steps({ network: true, apply: true }));
  assert.ok(r.fail && /^Error: the edit failed halfway \(could not reach the Google Docs API \(Failed to fetch\)\.\) and its first part was rolled back, so the document is as it was\./.test(r.fail.content), r.fail && r.fail.content);
  assert.strictEqual(fake.text('t.0'), 'Body text');
  deq(posts().slice(2), [DEL, DEL]); // the second batch's rollback, then the first's
  assert.strictEqual(gets() - g, 4); // after batch 1; the re-read (used by the first rollback); before the second; the final read
});

test('unclear failure, the batch did not arrive: only the earlier steps are rolled back', async () => {
  await fresh(spec());
  const r = await T.commitSequence(as, plan(), 'q2', steps({ network: true, apply: false }));
  assert.ok(r.fail && /rolled back, so the document is as it was/.test(r.fail.content), r.fail && r.fail.content);
  assert.strictEqual(fake.text('t.0'), 'Body text');
  deq(posts().slice(2), [DEL]);
  // a 5xx is unclear as well; this fake applies nothing on it, so the revision did not move
  await fresh(spec());
  const s = await T.commitSequence(as, plan(), 'q3', steps({ status: 503, message: 'Backend unavailable' }));
  assert.ok(s.fail && /rolled back/.test(s.fail.content), s.fail && s.fail.content);
  assert.strictEqual(fake.text('t.0'), 'Body text');
  deq(posts().slice(2), [DEL]);
});

test('unclear failure and the re-read fails: nothing is rolled back, the message says to check the document', async () => {
  await fresh(spec());
  const r = await T.commitSequence(as, plan(), 'q4', [steps()[0], (m) => { fake.failNext = { network: true, apply: true }; fake.failReads = 1; return { requests: [T.reqInsert(m, 1, 'B')], rollback: del }; }]);
  assert.strictEqual(r.fail.content, 'Error: the edit failed halfway (could not reach the Google Docs API (Failed to fetch).): its first part was applied, and whether the rest arrived is unknown '
    + 'because the document could not be read again. The edit may be partly applied; check the document before editing again.');
  assert.strictEqual(r.fail._message, 'The edit may be partly applied; check the document');
  assert.strictEqual(r.fail._ok, false);
  assert.strictEqual(posts().length, 2); // no rollback sent
  assert.strictEqual(fake.text('t.0'), 'BABody text');
  deq(as.responseWrite, { from: 1, to: 1 });
});

test('a clear refusal (400) of a later batch: the earlier steps are rolled back, without the extra read', async () => {
  await fresh(spec());
  const g = gets();
  const r = await T.commitSequence(as, plan(), 'q5', steps({ status: 400, message: 'Invalid requests[0].insertText: boom' }));
  assert.ok(r.fail && /rolled back/.test(r.fail.content), r.fail && r.fail.content);
  assert.strictEqual(fake.text('t.0'), 'Body text');
  deq(posts().slice(2), [DEL]);
  assert.strictEqual(gets() - g, 3); // after batch 1; before the rollback; the final read
});
