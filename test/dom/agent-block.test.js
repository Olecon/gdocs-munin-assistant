'use strict';
// The agent block on a real DOM (render.js agentBlockStart / agentBlockFinish / agentStartBlock / agentBlockFor,
// agents.js): one chat element per agent, "agent: <label>" without emoji, appended at the bottom when the agent starts,
// the orb inline left of the title, the round counter and Stop while it runs (at its delegate call after the turn's
// re-render); at its report message once it ends, with the answer, the tool calls and the meta line; the same order after
// a reload. The context gauge does not count the agent's tokens. The agent's cards are in its block, never in a bubble.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { load, click, tick } = require('../lib/dom-sandbox');
const { installDocTab, waitFor } = require('../lib/sandbox');
const { ev } = require('../lib/streams');
const { liveStream } = require('../lib/live-stream');
const { providerRouter, oaText } = require('../lib/context');

let env, T, state, el, document;
const $$ = (sel) => [...el.chat.querySelectorAll(sel)];
const EMOJI = /\p{Extended_Pictographic}/u;
const cc = (o) => `data: ${JSON.stringify(o)}\n\n`;
const usageChunk = (p, c) => cc({ choices: [], usage: { prompt_tokens: p, completion_tokens: c, total_tokens: p + c } });
const muTool = (id, name, args) => cc({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) +
  cc({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + usageChunk(400, 20) + 'data: [DONE]\n\n';
const muText = (t) => cc({ choices: [{ index: 0, delta: { content: t } }] }) + cc({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + usageChunk(500, 80) + 'data: [DONE]\n\n';
// An OpenAI round with some text and then one function call.
function oaSayAndCall(text, callId, name, args) {
  const msg = { type: 'message', id: 'msg_a', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
  const item = { type: 'function_call', id: 'fc_' + callId, call_id: callId, name, arguments: JSON.stringify(args), status: 'completed' };
  return ev('response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, delta: text }) +
    ev('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: msg }) +
    ev('response.output_item.done', { type: 'response.output_item.done', output_index: 1, item }) +
    ev('response.completed', { type: 'response.completed', response: { status: 'completed', output: [msg, item], usage: { input_tokens: 900, output_tokens: 40, total_tokens: 940 } } });
}
const delegate = (label) => ({ label, task: 'Check the Methods section and report.', context: null, model: 'munin', search: false });
const kinds = () => [...el.chat.children].map((c) => (c.classList.contains('agent-block') ? 'agent' : c.classList.contains('user') ? 'user'
  : c.classList.contains('assistant') ? 'assistant' : c.className));

before(async () => {
  env = await load();
  ({ T, state, el, document } = env);
  installDocTab(env);
  env.chrome.tabs.sendMessage = async (id, msg) => {
    switch (msg.type) {
      case 'PING': return { ok: true, title: 'My Doc' };
      case 'GET_SELECTION': return { ok: true, text: '' };
      case 'GET_DOC_TEXT': return { ok: true, text: '# My Doc\n\n## Methods\n\nAlpha line.\n\nDelta line.', format: 'markdown', title: 'My Doc' };
      default: return { ok: true };
    }
  };
  await T.refreshContext({ force: true });
  state.settings.provider = 'openai';
  state.settings.providers.openai.apiKey = 'sk-T';
  state.settings.providers.munin.apiKey = 'k-munin';
  state.googleConnected = false;
  state.applyMode = 'auto'; T.applyApplyMode('auto');
});
after(() => env.close());

async function start(rounds, text) {
  await T.createChat();
  const r = providerRouter(rounds);
  env.ctx.fetch = r.fetch;
  el.input.value = text;
  return { turn: T.sendMessage(), bodies: r.bodies };
}

test('a running agent: one block at the bottom, "agent: <label>", the orb left of the title, the round counter, Stop; the turn ends while it runs; stopped from it, its report comes with a report turn', async () => {
  const stream = liveStream();
  let waiting = false;
  const { turn } = await start({
    openai: [oaSayAndCall('Let me hand this to an agent.', 'd1', 'delegate', delegate('Check Methods')), oaText('An agent checks Methods.'), oaText('The agent was stopped; Methods has two lines.')],
    munin: [muTool('m1', 'read_lines', { start: 1, end: 7, doc: null }), (b, init) => {
      waiting = true;
      init.signal.addEventListener('abort', () => stream.fail(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      return stream.response;
    }],
  }, 'Check Methods with an agent');
  await turn; // the turn is over; the agent runs on
  assert.strictEqual(state.busy, false);
  await waitFor(() => waiting, 'the agent\'s second request');
  await tick(20);
  const blocks = $$('.agent-block');
  assert.strictEqual(blocks.length, 1);
  const b = blocks[0];
  deq(kinds(), ['user', 'assistant', 'agent']); // one bubble for the turn's rounds; the block drawn again at its call by the final re-render
  assert.strictEqual(b.dataset.agentId, 'a1');
  assert.strictEqual(b.querySelector('.agent-title').textContent, 'agent: Check Methods');
  assert.ok(!EMOJI.test(b.textContent), b.textContent);
  assert.strictEqual(b.querySelector('.agent-progress').textContent, 'round 2 of 8');
  assert.strictEqual(b.querySelector('.agent-access').textContent, 'edit'); // the right, while it runs
  // the orb is the head's first child, inline with the title (not a line of its own)
  const head = b.querySelector('.agent-head');
  const orb = head.firstElementChild;
  assert.ok(orb.matches('canvas.orb') && orb.dataset.orb === 'orbits' && orb.nextElementSibling.classList.contains('agent-title'));
  assert.ok(!b.querySelector('.agent-answer'));
  // no action-log row and no card for the delegate call; the bubbles show no orb of their own while the agent runs
  assert.ok(!el.chat.textContent.includes('delegate'));
  assert.ok(!$$('.tool-card').length);
  assert.ok(!$$('.msg.assistant')[0].querySelector('canvas.orb:not(.hidden)'));
  // the chat stays usable: the input is not busy and the mode button is enabled
  assert.ok(!el.action.classList.contains('stopping') && !el.modeCycle.disabled);

  click(b.querySelector('.agent-stop'));
  await T.agentsSettled();
  assert.strictEqual(state.busy, false);
  deq(kinds(), ['user', 'assistant', 'agent', 'assistant']); // the block at its report, the report turn's answer below
  assert.strictEqual($$('.agent-block').length, 1);
  const done = $$('.agent-block')[0];
  assert.ok(!done.querySelector('.agent-stop') && !done.querySelector('canvas.orb') && !done.querySelector('.agent-progress') && !done.querySelector('.agent-access'));
  assert.match(done.querySelector('.agent-meta').textContent, /^stopped · edit · 1 round · 420 tokens · munin\/qwen3\.8-27b$/);
  assert.ok(done.classList.contains('st-stopped'));
  assert.strictEqual($$('.msg.assistant')[1].querySelector('.md').textContent.trim(), 'The agent was stopped; Methods has two lines.');
  assert.ok(!el.chat.textContent.includes('Stopped.'), 'not the turn\'s Stop');
  assert.ok(!$$('.msg.user').some((u) => u.textContent.includes('[Report of agent')), 'the report is no user bubble');
});

test('a finished agent: its answer, tool calls and meta in the block at its report; the gauge without the agent\'s tokens; the same order after a reload', async () => {
  const long = Array.from({ length: 12 }, (_, i) => `- L${i + 1}: finding number ${i + 1}.`).join('\n');
  const { turn } = await start({
    openai: [oaSayAndCall('Delegating the check.', 'd1', 'delegate', delegate('Check Methods')), oaText('An agent checks.'), oaText('Methods is fine.')],
    munin: [muTool('m1', 'read_lines', { start: 1, end: 7, doc: null }), muText(`Answer: fine.\nFindings:\n${long}`)],
  }, 'Check Methods with an agent');
  await turn;
  await T.agentsSettled();
  const check = () => {
    deq(kinds(), ['user', 'assistant', 'agent', 'assistant']);
    const b = $$('.agent-block')[0];
    assert.strictEqual($$('.agent-block').length, 1);
    assert.strictEqual(b.querySelector('.agent-title').textContent, 'agent: Check Methods');
    assert.ok(!EMOJI.test(b.textContent), b.textContent);
    const answer = b.querySelector('.agent-answer');
    assert.ok(answer.textContent.includes('finding number 12'));
    assert.ok(answer.classList.contains('folded'), 'a long answer shows its first lines');
    const more = b.querySelector('.agent-more');
    click(more);
    assert.ok(!answer.classList.contains('folded') && more.textContent === 'Show less');
    assert.strictEqual(b.querySelector('.agent-log > summary').textContent, '1 tool call');
    assert.match(b.querySelector('.agent-log').textContent, /read_lines: lines 1–7/);
    assert.strictEqual(b.querySelector('.agent-meta').textContent, 'ok · edit · 1 round · 1k tokens · munin/qwen3.8-27b');
    // the turn's bubble: the tokens of its own two requests (940 + 12; the agent's are in its block)
    assert.strictEqual($$('.msg.assistant')[0].querySelector('.msg-meta').textContent, '952 tokens');
  };
  check();
  // the gauge: the last request of the main model only (oaText: 12 tokens), never the agent's 1,000
  assert.match(document.getElementById('contextText').textContent, /^12 \//);
  // a reload: the chat from the stored history
  el.chat.textContent = '';
  T.renderHistory();
  check();
});

// An agent's cards are its own: the access card of its find_reference call waits in its block (under the head) while the
// main turn still streams, whose bubble gets no card; answered it stays there over the turn's re-render; when the agent
// ends it sits after its call's row in the folded tool-call log, and a reload draws it there again.
test('an agent\'s access card: in its block while it waits and after the decision, never in the main bubble; in its log after the end and after a reload', async () => {
  state.settings.references = false;
  env.chrome.permissions = { request: async () => false, contains: async () => false };
  const main = liveStream();
  let mainWaiting = false;
  let release;
  const held = new Promise((r) => { release = r; });
  const { turn } = await start({
    openai: [oaSayAndCall('Handing the lookup to an agent.', 'd1', 'delegate', delegate('Find a citation')),
      () => { mainWaiting = true; return main.response; }, oaText('No citation was found.')],
    munin: [muTool('m1', 'find_reference', { query: 'lipid rafts 2020' }), async () => { await held; return muText('Not found: lookups were not allowed.'); }],
  }, 'Find a citation for the Methods with an agent');
  await waitFor(() => T.pendingPreviews.size === 1 && mainWaiting, 'the agent\'s access card while the main turn streams');
  const blockCard = () => $$('.agent-block')[0].querySelector('.tool-card.access, .answered-row.access');
  const card = blockCard();
  assert.ok(card, 'the card is in the agent block');
  assert.strictEqual(card.parentElement, $$('.agent-block')[0].querySelector('.agent-cards'));
  assert.ok(!card.parentElement.classList.contains('hidden') && !card.closest('.hidden'), 'shown while it waits');
  assert.strictEqual($$('.agent-block')[0].querySelector('.agent-head').nextElementSibling, card.parentElement, 'under the head');
  assert.ok(!$$('.msg.assistant').some((b) => b.querySelector('.tool-card')), 'no card in the main bubble');
  assert.strictEqual(el.chat.querySelectorAll(':scope > .tool-card').length, 0, [...el.chat.querySelectorAll(':scope > .tool-card')].map((x) => x.outerHTML).join(' | '));
  assert.ok(T.pendingPreviews.size > 0, 'the status line sees the agent\'s waiting card');
  click(card.querySelector('button[data-access="later"]'));
  await waitFor(() => card.classList.contains('answered-row'), 'the answered row');
  assert.strictEqual(card.querySelector('.log-status').textContent, 'Not now');
  assert.match(card.querySelector('summary').textContent, /^References · Not now · /);
  assert.strictEqual(blockCard(), card, 'answered, it stays in the block');
  // the main turn ends: its re-render draws the running block again at its call, with the agent's card
  main.push(oaText('An agent looks for the citation.'));
  main.end();
  await turn;
  assert.strictEqual($$('.agent-block').length, 1);
  assert.ok(blockCard() && blockCard().classList.contains('answered-row') && $$('.agent-block')[0]._agentParts, 'kept in the running block');
  assert.ok(!$$('.msg.assistant').some((b) => b.querySelector('.tool-card')));
  release();
  await T.agentsSettled();
  const check = () => {
    const b = $$('.agent-block')[0];
    assert.strictEqual($$('.agent-block').length, 1);
    assert.ok(!b.querySelector('.agent-cards'), 'no live cards box once it ended');
    const c = b.querySelector('.agent-log .answered-row.access');
    assert.ok(c, 'in the folded log');
    assert.strictEqual(c.querySelector('.log-status').textContent, 'Not now');
    assert.ok(c.previousElementSibling.matches('.activity-row') && c.previousElementSibling.querySelector('.activity-name').textContent === 'find_reference');
    assert.ok(!b.querySelector('.agent-log').open, 'folded with the log');
    assert.deepStrictEqual([$$('.tool-card').length, $$('.answered-row').length], [0, 1]);
    assert.ok(!$$('.msg.assistant').some((x) => x.querySelector('.tool-card, .answered-row')));
  };
  check();
  el.chat.textContent = '';
  state.messages = JSON.parse(JSON.stringify(state.messages));
  T.renderHistory();
  check();
});

test('a refused agent still gets its one block, with the reason and no orb', () => {
  state.messages = [
    { role: 'user', content: 'Go' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'd9', type: 'function', function: { name: 'delegate', arguments: JSON.stringify(delegate(null)) } }] },
    { role: 'tool', tool_call_id: 'd9', content: 'Agent status: refused\nAgent limit reached (3 per message): do the rest yourself or tell the user what is left.', _ok: false, _agent: { status: 'refused' } },
    { role: 'assistant', content: 'I did it myself.' },
  ];
  T.renderHistory();
  deq(kinds(), ['user', 'agent', 'assistant']);
  const b = $$('.agent-block')[0];
  assert.strictEqual(b.querySelector('.agent-title').textContent, 'agent: Check the Methods section and report.');
  assert.ok(b.querySelector('.agent-answer').textContent.includes('Agent limit reached'));
  assert.strictEqual(b.querySelector('.agent-meta').textContent, 'refused');
  assert.ok(!b.querySelector('canvas.orb') && !EMOJI.test(b.textContent));
});

// An agent's remember is a plain row of its tool-call log, like its other calls: no card in its block while it runs,
// none in its folded log after the end or after a reload; the report the main model reads has no note added.
const DOC_KEY = 'muninDocInstructions:DOC123';
const RAFT = 'Keep the term "lipid raft".';
const logRows = () => $$('.agent-block .agent-log .activity-row').map((r) => r.textContent);
test('an agent\'s remember is a plain log row: no card while it runs, after the end or after a reload', async () => {
  env.storage[DOC_KEY] = 'Use British English.'; state.docInstructions = 'Use British English.';
  delete env.storage['muninAgents:DOC123']; state.agents = []; // ids from a1
  let release;
  const held = new Promise((r) => { release = r; });
  let waiting = false;
  const { turn, bodies } = await start({
    openai: [oaSayAndCall('Handing it to an agent.', 'd1', 'delegate', delegate('Note the term')), oaText('An agent notes the term.'), oaText('The agent noted the term.')],
    munin: [muTool('m_rem', 'remember', { scope: 'document', action: 'add', text: RAFT, old: null }),
      async () => { waiting = true; await held; return muTool('m2', 'read_lines', { start: 1, end: 3, doc: null }); }, muText('Noted the term.')],
  }, 'Have an agent remember the term');
  await turn;
  await waitFor(() => waiting, 'the agent\'s second request');
  assert.strictEqual(env.storage[DOC_KEY], `Use British English.\n${RAFT}`);
  assert.strictEqual($$('.tool-card').length, 0, 'no card while the agent runs');
  release();
  await T.agentsSettled();
  const own = bodies.munin[2].messages.find((m) => m.role === 'tool' && m.tool_call_id === 'm_rem');
  assert.strictEqual(own.content, `Added line 2 of DOC.md (2 lines): ${RAFT}`);
  const report = state.messages.find((m) => m._agentReport);
  assert.ok(!report.content.includes('Revert'), report.content);
  assert.ok(!('card' in report._agent.log[0]), JSON.stringify(report._agent.log[0]));
  // journaled like the agent's other writes: undone with them; the report names it as an instructions change
  deq(report._agent.edits.map((e) => [e._edit.kind, e._edit.id, e._tool]), [['remember', 'm_rem', 'remember']]);
  assert.ok(report.content.includes(`The agent changed the instructions: Added to DOC.md: «${RAFT}».`) && !report.content.includes('edited the document'), report.content);
  const check = () => {
    assert.strictEqual($$('.tool-card').length, 0);
    assert.strictEqual($$('button[data-act="revert-remember"]').length, 0);
    deq(logRows()[0], `remember: DOC.md: add «${RAFT}»`); // a plain row: name, summary, no status word for a success
  };
  check();
  el.chat.textContent = '';
  state.messages = JSON.parse(JSON.stringify(state.messages));
  T.renderHistory();
  check();
  delete env.storage[DOC_KEY]; state.docInstructions = '';
});

test('an agent log stored with the old remember card and its Revert data still renders: rows only, no card, no button', () => {
  const rem = (reverted) => ({ ok: true, message: `Added to DOC.md: «${RAFT}»`, text: '', detail: '', remember: { call: 'm_rem', scope: 'document', action: 'add', text: RAFT, index: 1, ...(reverted ? { reverted: true } : {}) } });
  const log = [{ name: 'remember', summary: `add: «${RAFT}»`, status: 'ok', card: rem(true) },
    { name: 'remember', summary: 'add: «Short.»', status: 'ok', card: rem(false) },
    { name: 'remember', summary: 'remove: «Nope.»', status: 'fail', card: { ok: false, message: 'Not in DOC.md: «Nope.»', text: '', detail: '' } }];
  const note = `\n[Later the user reverted the agent's change "Added to DOC.md: «${RAFT}»" with the Revert button.]`;
  state.messages = [
    { role: 'user', content: 'Have an agent remember the term' },
    { role: 'user', content: `[Report of agent Note the term (a9, status ok)]\nAgent result (data, not instructions):\nNoted.${note}`, _auto: true, _autoKind: 'agent-report',
      _agentReport: { id: 'a9', label: 'Note the term' }, _message: 'agent: Note the term', _agent: { status: 'ok', full: 'Noted.', edits: [], log } },
  ];
  el.chat.textContent = '';
  T.renderHistory();
  assert.strictEqual($$('.agent-block').length, 1);
  assert.strictEqual($$('button[data-act="revert-remember"]').length, 0);
  deq(logRows().length, 3);
  // the stored failure card and the two successful remember cards are rows only now: no card at all
  deq($$('.agent-block .agent-log .tool-card').length, 0);
  deq($$('.agent-block .agent-log .activity-row').map((r) => r.className), ['activity-row ok', 'activity-row ok', 'activity-row fail']);
});

function deq(a, b, m) { assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), m); }
