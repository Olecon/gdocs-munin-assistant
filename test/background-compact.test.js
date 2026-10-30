'use strict';
// Background compaction after a turn (backgroundCompact in compaction.js, started by sendMessage): when the next
// request's estimate (the context gauge's nextRequestEstimate) reaches BACKGROUND_COMPACT_RATIO (90%) of the compaction
// trigger, the history is folded (or summarized) right after the turn, under the chat lock, so the next message starts
// compacted. Not under the threshold, not while a turn or an Undo runs, not when the chat lock is held elsewhere; a
// message sent meanwhile stops it and its own turn goes first (the summary that was under way is not applied).
const { test, before } = require('node:test');
const assert = require('node:assert');
const { load } = require('./lib/sandbox');
const { sseResponse } = require('./lib/streams');
const { liveStream } = require('./lib/live-stream');
const { docBench, recordFetch, useProvider, send, muText } = require('./lib/context');

let env, T, state, doc;

before(async () => {
  env = await load();
  ({ T, state } = env);
  ({ doc } = docBench(env));
  doc.text = '# Notes\n\nFirst.\n\nSecond.';
  await T.refreshContext({ force: true });
  useProvider(env, 'munin');
});

const budget = () => T.compactionBudget('edit', { prov: T.activeProvider() });
const estimate = () => T.nextRequestEstimate('edit', T.activeHistory(state.messages));
// Three earlier turns whose bulk sits in edit results (folding drops them) or in the user texts (folding keeps them:
// only a summary helps), sized so that the next request is estimated at `share` of the compaction trigger.
async function bulkyChat(share, where = 'results') {
  await T.createChat();
  T.el.chat.children.length = 0;
  const turn = (k, bulk) => (where === 'results'
    ? [{ role: 'user', content: `Edit part ${k}` },
      { role: 'assistant', content: null, tool_calls: [{ id: `e${k}`, type: 'function', function: { name: 'replace_text', arguments: '{"old_text":"a","new_text":"b"}' } }] },
      { role: 'tool', tool_call_id: `e${k}`, content: bulk, _ok: true },
      { role: 'assistant', content: `Done ${k}.` }]
    : [{ role: 'user', content: `Part ${k}: ${bulk}` }, { role: 'assistant', content: `Noted ${k}.` }]);
  state.messages = [1, 2, 3].flatMap((k) => turn(k, ''));
  const base = estimate();
  // the turn of the test adds its own message and answer (about 100 tokens with the turn context)
  const per = Math.max(0, Math.floor(((share * budget() - base - 150) * 3) / 3));
  state.messages = [1, 2, 3].flatMap((k) => turn(k, String(k).repeat(per)));
  await T.saveHistory();
}
const isSummaryRequest = (b) => b.messages && b.messages[0] && b.messages[0].role === 'system' && b.messages[0].content === T.COMPACT_PROMPT;

test('over 90% of the trigger after a turn: the history is folded in the background, without a request', async () => {
  await bulkyChat(0.95);
  assert.ok(estimate() < budget(), 'the turn itself does not compact');
  const bodies = recordFetch(env, [muText('Fine.')]);
  await send(env, 'Anything else?');
  const run = state.bgCompaction;
  assert.ok(run, 'started after the turn');
  assert.strictEqual(await run.done, true);
  assert.strictEqual(state.bgCompaction, null);
  assert.strictEqual(bodies.length, 1, 'the fold needs no request');
  const fold = state.messages.find((m) => m._summary);
  assert.ok(fold && fold._folded);
  assert.ok(estimate() < T.BACKGROUND_COMPACT_RATIO * budget());
  // stored, and the last turn is not compacted
  const stored = env.storage['muninChatHistory:DOC123:' + state.chatId];
  assert.ok(stored.some((m) => m._summary && m._folded));
  assert.ok(!state.messages.find((m) => m.content === 'Anything else?')._compacted);
  // the next message starts from the compacted history: one request, no compaction at its start
  const next = recordFetch(env, [muText('Sure.')]);
  await send(env, 'Thanks');
  assert.strictEqual(next.length, 1);
  assert.ok(next[0].messages.some((m) => m.role === 'user' && String(m.content).startsWith(T.SUMMARY_PREFIX)));
});

test('under 90%: nothing runs in the background', async () => {
  await bulkyChat(0.8);
  const bodies = recordFetch(env, [muText('Fine.')]);
  await send(env, 'Anything else?');
  assert.strictEqual(state.bgCompaction, null);
  assert.strictEqual(bodies.length, 1);
  assert.ok(!state.messages.some((m) => m._summary));
});

test('a message sent during the background summary wins: the summary is stopped and not applied, the turn goes first', async () => {
  await bulkyChat(0.95, 'texts'); // folding keeps the user texts: a summary request is needed
  const pending = liveStream();
  const bodies = [];
  let summaries = 0;
  env.ctx.fetch = async (url, init) => {
    const b = JSON.parse(init.body);
    bodies.push(b);
    if (isSummaryRequest(b)) {
      summaries++;
      if (summaries === 1) {
        init.signal.addEventListener('abort', () => pending.fail(Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' })));
        return pending.response;
      }
      return sseResponse(muText('Summary: three parts were noted.'));
    }
    return sseResponse(muText('Answer ' + bodies.length + '.'));
  };
  await send(env, 'First question');
  const run = state.bgCompaction;
  assert.ok(run);
  for (let i = 0; i < 400 && pending.reads === 0; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(pending.reads > 0, 'the summary request is under way');
  assert.strictEqual(state.busy, false, 'the panel stays free while it runs');
  await send(env, 'Second question'); // takes the chat lock: the background gives way
  assert.strictEqual(await run.done, false);
  const users = state.messages.filter((m) => m.role === 'user' && !m._summary).map((m) => m.content);
  assert.ok(users.includes('Second question'));
  // the second turn's request came before any applied summary; the background after it ran once more
  const turnBodies = bodies.filter((b) => !isSummaryRequest(b));
  assert.strictEqual(turnBodies.length, 2);
  assert.ok(!turnBodies[1].messages.some((m) => String(m.content).startsWith(T.SUMMARY_PREFIX)), 'the stopped summary was not applied');
  assert.ok(turnBodies[1].messages.some((m) => String(m.content).includes('Part 1: ')), 'the second turn sent the full history');
  if (state.bgCompaction) await state.bgCompaction.done;
  assert.strictEqual(summaries, 2);
  const summary = state.messages.find((m) => m._summary);
  assert.ok(summary && summary.content.includes('three parts'));
  assert.ok(!state.messages.find((m) => m.content === 'Second question')._compacted, 'the newest turn is kept');
});

test('a chat locked elsewhere, a running Undo or turn: no background compaction', async () => {
  await bulkyChat(0.95);
  const release = await T.holdChatLock(state.docId, state.chatId); // as if another tab answered in this chat
  try {
    const p = T.backgroundCompact();
    assert.ok(p);
    assert.strictEqual(await p, false);
    assert.ok(!state.messages.some((m) => m._summary));
  } finally {
    release();
  }
  state.undoing = true;
  try { assert.strictEqual(T.backgroundCompact(), null); } finally { state.undoing = false; }
  state.busy = true;
  try { assert.strictEqual(T.backgroundCompact(), null); } finally { state.busy = false; }
  // free again: it runs
  assert.strictEqual(await T.backgroundCompact(), true);
});
