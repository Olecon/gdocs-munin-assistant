'use strict';
// The first-run document instructions (src/doc-init.js): the trigger (empty instructions, enough text, no earlier
// turn in the document, no slash command, once per document), the pass request (the init task with the user's first
// request, no chat history), run in the background beside the turn (the turn's answer does not wait for it; the lines
// apply from the next message), a remember of the turn meanwhile (both kept), Stop (with the turn, or alone from the
// pass's row) and a failed pass (its row says so, the chat goes on). The pass's row: an action row under the first turn
// (running, done, stopped, failed), its outcome stored with the attempt flag; its markup is tested in test/dom.
const { test } = require('node:test');
const assert = require('node:assert');
const { deq, load, waitFor, turnRowTexts } = require('./lib/sandbox');
const { docBench, recordFetch, useProvider, send, muText, muTool } = require('./lib/context');
const { sseResponse } = require('./lib/streams');

const DOC = '# Lipid rafts in T cells\n\n## Abstract\n\n' + 'We study how lipid rafts organise signalling proteins in the membrane of T cells. '.repeat(4) +
  '\n\n## Methods\n\nCells were imaged with STED microscopy and analysed in Python (Smith et al., 2020).';
const NOTE = '```\nHere is the project note:\n- Research article in cell biology.\n- British English.\n* Keep the terms "lipid raft", "STED".\n1. Citation style: author-year.\n\n**Wants:** a tighter abstract.\n```';
const LINES = ['Research article in cell biology.', 'British English.', 'Keep the terms "lipid raft", "STED".', 'Citation style: author-year.', 'Wants: a tighter abstract.'];
const KEY = 'muninDocInstructions:DOC123';
const FLAG = 'muninDocInit:DOC123';

async function fresh(text = DOC) {
  const env = await load({ docInit: true });
  const { doc } = docBench(env);
  doc.text = text;
  await env.T.refreshContext({ force: true });
  useProvider(env, 'munin');
  return { env, doc, T: env.T, state: env.state, storage: env.storage };
}
const isPass = (b) => b.messages.some((m) => typeof m.content === 'string' && m.content.includes('Project note task.'));
const rowTexts = (T) => turnRowTexts(T.el.chat); // the turns' own rows and the rows outside a turn
// The pass's row in the chat: its view ({ status, added, lines, reason }) or null.
const passRow = (T) => { const d = T.el.chat.children.find((c) => /\bdoc-init-row\b/.test(c.className || '')); return d ? d._docInit : null; };
const liveRow = (T) => !!passRow(T) && passRow(T).status === 'running';
const aborted = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

// The provider's fetch with the pass held back: the turn's requests get the rounds in order, the pass's request waits
// until pass.release(sse) (or rejects on its signal). Returns { turn: the turn's bodies, pass: { body, release, aborted } }.
function holdPass(env, rounds) {
  const turn = [];
  const pass = { body: null, release: null, aborted: false };
  env.ctx.fetch = async (url, init) => {
    const b = JSON.parse(init.body);
    if (isPass(b)) {
      pass.body = b;
      return new Promise((res, rej) => {
        pass.release = (sse) => res(sseResponse(sse));
        init.signal.addEventListener('abort', () => { pass.aborted = true; rej(aborted()); });
      });
    }
    turn.push(b);
    const r = rounds[Math.min(turn.length - 1, rounds.length - 1)];
    return sseResponse(typeof r === 'function' ? r(b) : r);
  };
  return { turn, pass };
}

test('parseDocInit: fences, bullets, numbering, bold and an intro line stripped; at most 10 lines; mergeDocInit appends', async () => {
  const { T } = await fresh();
  deq(T.parseDocInit(NOTE), LINES);
  deq(T.parseDocInit(Array.from({ length: 14 }, (_, i) => `- line ${i}`).join('\n')).length, 10);
  deq(T.parseDocInit('  \n\n'), []);
  deq(T.mergeDocInit('', ['a', 'b']), { text: 'a\nb', added: 2 });
  deq(T.mergeDocInit('Mine.\n', ['a', 'b']), { text: 'Mine.\n\na\nb', added: 2 });
  const full = 'x'.repeat(T.DOC_INSTRUCTIONS_MAX - 4);
  deq(T.mergeDocInit(full, ['abc', 'de']), { text: full, added: 0 }); // whole lines only, within the cap
});

test('the first message: the turn answers while the pass runs; the pass writes the instructions, the next message carries them', async () => {
  const { env, T, state, storage } = await fresh();
  const { turn, pass } = holdPass(env, [muText('Done.')]);
  await send(env, 'tighten the abstract'); // the whole turn, with the pass still pending
  assert.strictEqual(state.busy, false);
  assert.strictEqual(state.abort, null, 'the pass leaves state.abort alone');
  deq(state.messages.map((m) => [m.role, m.content]), [['user', 'tighten the abstract'], ['assistant', 'Done.']]);
  assert.strictEqual(turn.length, 1);
  assert.ok(!isPass(turn[0]) && !turn[0].messages[0].content.includes('<DOC.md>'), 'the first answer goes without them');
  await waitFor(() => pass.release, 'the pass request');
  assert.ok(T.docInitRunning(), 'the pass still runs');
  assert.ok(liveRow(T), 'the live row');
  assert.ok(!/instructions/i.test(T.el.docStatus.textContent), 'nothing on the status line');
  // the pass request: the init task, the numbered document, the first request, no chat history
  const p = pass.body;
  deq([p.persona, p.tools, p.messages.map((m) => m.role)], ['raw', undefined, ['system', 'user']]);
  assert.ok(p.messages[0].content.startsWith(T.DOC_PASS_HEADS.card) && !p.messages[0].content.includes('W1.'));
  const user = p.messages[1].content;
  assert.ok(user.includes('3: ## Abstract') && user.includes(T.DOC_INIT_TASK), 'the numbered document and the task');
  assert.ok(user.endsWith("The user's first request: tighten the abstract"));
  assert.ok(!(KEY in storage) && !storage[FLAG]);
  const before = Date.now();
  pass.release(muText(NOTE));
  await T.docInitRunning().done;
  assert.strictEqual(storage[KEY], LINES.join('\n'));
  assert.ok(storage['muninDocInstructionsAt:DOC123'] >= before, 'the save time next to the text');
  assert.strictEqual(state.docInstructions, LINES.join('\n'));
  assert.ok(storage[FLAG]);
  deq(passRow(T), { status: 'done', added: 5, lines: LINES }, 'the row is done, with the lines written');
  deq([storage[FLAG].status, storage[FLAG].added, storage[FLAG].lines], ['done', 5, LINES], 'the outcome stored with the attempt');
  deq(state.messages.filter((m) => m.role === 'user').map((m) => m.content), ['tighten the abstract']); // the pass leaves no trace in the history
  assert.ok(!rowTexts(T).some((t) => t.includes('DOC.md')), 'no row');
  // the second message: no pass, the instructions in its head
  const next = recordFetch(env, [muText('ok')]);
  await send(env, 'and the title');
  assert.strictEqual(next.length, 1);
  assert.ok(next[0].messages[0].content.includes(`<DOC.md>\n${LINES.join('\n')}\n</DOC.md>`));
});

test('a second message while the pass runs goes out at once; no second pass', async () => {
  const { env, T, state, storage } = await fresh();
  const { turn, pass } = holdPass(env, [muText('One.'), muText('Two.')]);
  await send(env, 'tighten the abstract');
  await waitFor(() => pass.release, 'the pass request');
  await send(env, 'and the title');
  assert.strictEqual(turn.length, 2);
  assert.strictEqual(state.messages.filter((m) => m.role === 'assistant').length, 2);
  const run = T.docInitRunning();
  assert.strictEqual(run.later.length, 1, 'the second turn\'s Stop would stop the pass');
  pass.release(muText('British English.'));
  await run.done;
  assert.strictEqual(run.later.length, 0, 'its abort listener is removed once the pass ends');
  assert.strictEqual(storage[KEY], 'British English.');
});

test('remember during the turn while the pass runs: the pass appends its lines after a blank line', async () => {
  const { env, T, storage } = await fresh();
  const { pass } = holdPass(env, [
    muTool('call_rem', 'remember', { scope: 'document', action: 'add', text: 'Always use SI units.', old: null }),
    muText('Noted.'),
  ]);
  await send(env, 'from now on, always use SI units');
  assert.strictEqual(storage[KEY], 'Always use SI units.', 'the turn wrote its rule');
  await waitFor(() => pass.release, 'the pass request');
  pass.release(muText('British English.\nResearch article.'));
  await T.docInitRunning().done;
  assert.strictEqual(storage[KEY], 'Always use SI units.\n\nBritish English.\nResearch article.');
});

test('the result is dropped when the panel shows another document by then', async () => {
  const { env, T, state, storage } = await fresh();
  const { pass } = holdPass(env, [muText('Done.')]);
  await send(env, 'tighten the abstract');
  await waitFor(() => pass.release, 'the pass request');
  state.docId = 'OTHER';
  pass.release(muText('British English.'));
  assert.strictEqual(await T.docInitRunning().done, 'failed');
  assert.ok(!(KEY in storage) && !('muninDocInstructions:OTHER' in storage));
  assert.ok(storage[FLAG], 'one attempt');
});

test('no pass: instructions set, a short document, a slash command, an earlier turn in another chat, a document tried before', async () => {
  const cases = [
    ['instructions set', async (c) => { c.storage[KEY] = 'Mine.'; await c.T.refreshContext({ force: true }); }],
    ['a short document', async (c) => { c.doc.text = 'Too short.'; await c.T.refreshContext({ force: true }); }, 'Too short.'],
    ['a slash command', null, null, '/chat what is this about?'],
    ['an earlier turn in another chat', async (c) => { c.state.chats.push({ id: 'old', title: 'Earlier chat', createdAt: 1, updatedAt: 1 }); }],
    ['tried before', async (c) => { c.storage[FLAG] = 1; }],
  ];
  for (const [what, prep, text, message] of cases) {
    const c = await fresh(text || DOC);
    if (prep) await prep(c);
    const bodies = recordFetch(c.env, [muText('ok')]);
    await send(c.env, message || 'tighten the abstract');
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(bodies.length >= 1 && !bodies.some(isPass), what);
    assert.ok(!c.T.docInitRunning(), what + ': no pass running');
    assert.ok(!c.storage[FLAG] || what === 'tried before', what + ': no attempt recorded');
  }
});

test('Stop of the turn stops the pass too: one attempt recorded, no instructions', async () => {
  const { env, T, state, storage } = await fresh();
  let mainSeen = false;
  const { pass } = holdPass(env, [muText('x')]);
  // the turn's request hangs until Stop
  const passFetch = env.ctx.fetch;
  env.ctx.fetch = (url, init) => {
    const b = JSON.parse(init.body);
    if (isPass(b)) return passFetch(url, init);
    mainSeen = true;
    return new Promise((res, rej) => init.signal.addEventListener('abort', () => rej(aborted())));
  };
  T.el.input.value = 'tighten the abstract';
  const run = T.sendMessage();
  await waitFor(() => pass.release && mainSeen, 'both requests');
  assert.ok(state.busy && liveRow(T));
  const done = T.docInitRunning().done;
  state.abort.abort(); // the panel's Stop
  await run;
  assert.strictEqual(await done, 'stopped');
  assert.ok(pass.aborted, 'the pass request was aborted');
  assert.strictEqual(state.busy, false);
  assert.ok(!(KEY in storage) && storage[FLAG], 'no instructions, one attempt recorded');
  deq(passRow(T), { status: 'stopped' }, 'the row says it was stopped');
  assert.strictEqual(storage[FLAG].status, 'stopped');
  assert.ok(T.el.chat.children.some((c) => c._parts && /^Stopped after /.test(c._parts.label.textContent)), 'the turn\'s label says it stopped');
});

test('Stop with no running turn: the live row\'s Stop stops the pass alone', async () => {
  const { env, T, state, storage } = await fresh();
  const { pass } = holdPass(env, [muText('Done.')]);
  await send(env, 'tighten the abstract');
  await waitFor(() => pass.release, 'the pass request');
  assert.strictEqual(state.busy, false);
  const run = T.docInitRunning();
  run.abort.abort(); // the live row's Stop (clicked in test/dom/doc-init.test.js)
  const done = run.done;
  assert.strictEqual(await done, 'stopped');
  assert.ok(pass.aborted);
  assert.ok(!(KEY in storage) && storage[FLAG]);
  deq(state.messages.map((m) => m.content), ['tighten the abstract', 'Done.']);
});

test('a failed pass: its row says why, the chat goes on without instructions; not tried again', async () => {
  const { env, T, state, storage } = await fresh();
  const { turn, pass } = holdPass(env, [muText('Done.')]);
  await send(env, 'tighten the abstract');
  await waitFor(() => pass.release, 'the pass request');
  pass.release(muText(''));
  assert.strictEqual(await T.docInitRunning().done, 'failed');
  assert.ok(!turn[0].messages[0].content.includes('<DOC.md>'));
  assert.ok(!(KEY in storage) && storage[FLAG]);
  deq(passRow(T), { status: 'failed', reason: 'the answer was empty' });
  const row = T.el.chat.children.find((c) => /\bdoc-init-row\b/.test(c.className || ''))._row;
  assert.ok(row.innerHTML.includes('not written: the answer was empty') && row.innerHTML.includes('Could not write DOC.md: the answer was empty. The chat goes on.'), row.innerHTML);
  assert.ok(!rowTexts(T).some((t) => t.includes('DOC.md')), 'no row');
  assert.strictEqual(state.messages.filter((m) => m.role === 'user').length, 1);
});
