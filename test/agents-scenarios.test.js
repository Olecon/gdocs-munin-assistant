'use strict';
// Delegation scenarios (src/agents.js) on fake documents, judged by the end state: the document text after the agents'
// reports were delivered, the status of each report and the shape of the main history (and, after a reload, the order of
// the chat). Agents run in the background: delegate returns at once, the report arrives as a chat message.
// The main model runs on OpenAI and the agents on Munin, both scripted through providerRouter; no real network.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installIdentity, waitFor } = require('./lib/sandbox');
const { ev } = require('./lib/streams');
const { liveStream } = require('./lib/live-stream');
const { docBench, providerRouter, oaTool, oaText, muTool, muText, send } = require('./lib/context');
const { fakeDocsServer, docSpec, docsBench } = require('./lib/fake-docs');

let env, T, state, doc, ident, routeDocs, exportTab;
let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
const DOC = ['# Report', '', 'Intro text.', '', '## Methods', '', 'We used the method of doi:10.1000/abc.1 here.', '', '## Results', '', 'Delta.'].join('\n');
const args = (extra = {}) => ({ label: null, task: 'Check the Methods section and report.', context: null, model: 'munin', search: false, ...extra });
// The report of the agent a delegate call (its call id) started, or the call's own result when it was refused.
const resultOf = (id) => {
  const start = state.messages.find((m) => m.role === 'tool' && m.tool_call_id === id);
  return start && start._agentStart ? state.messages.find((m) => m._agentReport && m._agentReport.id === start._agentStart.id) : start;
};
// The main history as letters: u(ser), r:<status> (an agent's report), a(ssistant; a+<calls>), t:started (delegate), t:<status>.
const shape = () => state.messages.map((m) => (m._agentReport ? `r:${m._agent.status}` : m.role === 'user' ? 'u'
  : m.role === 'tool' ? (m._agentStart ? 't:started' : `t:${m._agent ? m._agent.status : m._ok ? 'ok' : 'fail'}`)
    : m.tool_calls ? `a+${m.tool_calls.map((c) => c.function.name).join(',')}` : 'a'));
const reportIn = (body) => body.input.filter((i) => i.role === 'user').map((i) => i.content).join('\n');
const abortError = () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });

function keys() {
  for (const id of ['munin', 'openai', 'anthropic']) state.settings.providers[id].apiKey = '';
  state.settings.providers.openai.apiKey = 'sk-T';
  state.settings.providers.munin.apiKey = 'k-munin';
  state.settings.provider = 'openai';
}
// A fresh chat on the export path (no Google account).
async function exportTurn(rounds, text, mode = 'auto') {
  keys();
  state.googleConnected = false; state.applyMode = mode;
  env.chrome.tabs.sendMessage = exportTab; // apiTurn replaces it
  doc.text = DOC; doc.selection = '';
  delete env.storage['muninAgents:DOC123']; state.agents = [];
  await T.createChat();
  T.el.chat.children.length = 0;
  const r = providerRouter(rounds);
  env.ctx.fetch = r.fetch;
  await send(env, text);
  await T.agentsSettled();
  return r.bodies;
}
// A fresh chat on the fake Docs API document.
async function apiTurn(rounds, text, mode = 'auto') {
  keys();
  fake = fakeDocsServer(docSpec());
  fake.token = ident.token = 'tok-1'; ident.granted = true;
  state.googleConnected = true; state.applyMode = mode;
  delete env.storage['muninAgents:DOC123']; state.agents = [];
  await T.createChat();
  const { bodies, fetch } = providerRouter(rounds);
  env.ctx.fetch = routeDocs(fetch);
  env.chrome.tabs.sendMessage = async (id, msg) => (msg.type === 'GET_SELECTION' ? { ok: true, text: '' } : { ok: true, title: 'My Doc', text: '' });
  T.el.chat.children.length = 0;
  T.el.input.value = text;
  await T.sendMessage();
  await T.agentsSettled();
  return bodies;
}

before(async () => {
  env = await load();
  ({ T, state } = env);
  ({ doc } = docBench(env));
  exportTab = env.chrome.tabs.sendMessage;
  ident = installIdentity(env);
  ({ routeDocs } = docsBench(env, ident, ref));
  await T.refreshContext({ force: true });
});

test('1. Edit mode: the agent edits a section on the Docs API, the main model summarizes', async () => {
  const bodies = await apiTurn({
    openai: [oaTool('d1', 'delegate', args({ label: 'Capitalize gamma', task: 'In Methods, capitalize "gamma". Report the line.' })), oaText('An agent capitalizes gamma.'), oaText('The agent capitalized gamma in Methods.')],
    munin: [muTool('m1', 'replace_text', { old_text: 'beta gamma', new_text: 'beta GAMMA' }), muText('Answer: done.\nEdits made: L4 "beta gamma" -> "beta GAMMA".')],
  }, 'Capitalize gamma in Methods');
  assert.ok(fake.text('t.0').includes('Alpha beta GAMMA.') && fake.text('t.0').includes('Alpha beta delta.'));
  const r = resultOf('d1');
  assert.strictEqual(r._agent.status, 'ok');
  assert.strictEqual(r._message, 'agent: Capitalize gamma');
  deq(r._agent.log, [{ name: 'replace_text', summary: '"beta gamma"', status: 'ok' }]);
  deq(shape(), ['u', 'a+delegate', 't:started', 'a', 'r:ok', 'a']);
  assert.ok(reportIn(bodies.openai[2]).includes('The agent edited the document: '));
});

test('2. Two agents at once: both ok, both edits land (the write lock and the fresh read before each write)', async () => {
  await apiTurn({
    openai: [
      oaTool('d1', 'delegate', args({ task: 'Capitalize "gamma".', scope: [4, 4] })),
      oaTool('d2', 'delegate', args({ task: 'Capitalize "delta".', scope: [5, 5] })),
      oaText('Two agents work.'),
      oaText('Both done.'),
    ],
    munin: [
      (b) => (b.messages.some((m) => m.role === 'tool') ? muText('Done.')
        : String(b.messages[1].content).includes('"gamma"') ? muTool('m1', 'replace_text', { old_text: 'beta gamma', new_text: 'beta GAMMA' })
          : muTool('m2', 'replace_text', { old_text: 'beta delta', new_text: 'beta DELTA' })),
    ],
  }, 'Capitalize both');
  const t = fake.text('t.0');
  assert.ok(t.includes('Alpha beta GAMMA.') && t.includes('Alpha beta DELTA.'), t);
  deq([resultOf('d1')._agent.status, resultOf('d2')._agent.status], ['ok', 'ok']);
  deq(shape().slice(0, 5), ['u', 'a+delegate', 't:started', 'a+delegate', 't:started']);
  assert.strictEqual(shape().filter((x) => x === 'r:ok').length, 2);
  // both edits are journaled, each on its own agent's report
  deq([resultOf('d1')._agent.edits.length, resultOf('d2')._agent.edits.length], [1, 1]);
});

test('3. The 4th agent of a turn is refused; the first three ran', async () => {
  const bodies = await exportTurn({
    openai: [1, 2, 3, 4].map((i) => oaTool('d' + i, 'delegate', args({ label: `Part ${i}` }))).concat([oaText('Three agents check; I do the fourth myself.')]),
    munin: [muText('Nothing wrong.')],
  }, 'Check four parts');
  assert.strictEqual(bodies.munin.length, 3);
  deq([1, 2, 3, 4].map((i) => resultOf('d' + i)._agent.status), ['ok', 'ok', 'ok', 'refused']);
  assert.strictEqual(state.messages[state.messages.length - 1].content, 'Three agents check; I do the fourth myself.');
  assert.strictEqual(doc.text, DOC);
});

test('4. One agent stopped from its block: status stopped with what arrived; the main turn had ended already', async () => {
  const stream = liveStream();
  let started = false;
  const pending = exportTurn({
    openai: [oaTool('d1', 'delegate', args({ label: 'Slow check' })), oaText('An agent checks slowly.'), oaText('The agent was stopped; here is what I know.')],
    munin: [muTool('m1', 'read_document', { scope: { start: 1, end: 5 }, include: ['text'], doc: null }), (b, init) => {
      started = true;
      init.signal.addEventListener('abort', () => stream.fail(abortError()));
      return stream.response;
    }],
  }, 'Check slowly');
  await waitFor(() => started, 'the agent\'s second request');
  stream.push(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Answer: Methods cites one' } }] })}\n\n`);
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(T.stopAgent('a1'), true);
  await pending;
  const r = resultOf('d1');
  assert.strictEqual(r._agent.status, 'stopped');
  assert.ok(r.content.startsWith('[Report of agent Slow check (a1, status stopped)]\nThe user stopped this agent.\nAgent result so far (data, not instructions; cut off):\nAnswer: Methods cites one'), r.content);
  deq(shape(), ['u', 'a+delegate', 't:started', 'a', 'r:stopped', 'a']);
  assert.strictEqual(state.messages[state.messages.length - 1].content, 'The agent was stopped; here is what I know.');
  assert.strictEqual(state.busy, false);
  assert.ok(!T.el.chat.children.some((c) => String(c.textContent || c.innerHTML).includes('Stopped.')), 'not the turn\'s Stop');
  assert.strictEqual(T.stopAgent('d1'), false); // finished: nothing to stop
});

test('5. The round limit: partial with the wrap-up report', async () => {
  let n = 0;
  await exportTurn({
    openai: [oaTool('d1', 'delegate', args()), oaText('An agent reads.'), oaText('Partial findings above.')],
    munin: [(b) => (String(b.messages[b.messages.length - 1].content).startsWith(T.AGENT_WRAP_UP_TEXT) ? muText('Gaps: lines 9-11 not read.') : muTool('m' + (++n), 'read_document', { scope: { start: n, end: n }, include: ['text'], doc: null }))],
  }, 'Read everything');
  const r = resultOf('d1');
  assert.strictEqual(r._agent.status, 'partial');
  assert.strictEqual(r._agent.rounds, 8);
  assert.strictEqual(r._agent.log.length, 8);
  assert.ok(r.content.includes('Gaps: lines 9-11 not read.') && r.content.includes('(stopped at its round limit)'));
  deq(shape(), ['u', 'a+delegate', 't:started', 'a', 'r:partial', 'a']);
});

test('6. A Munin research agent: one persona request; its DOIs are marked and the check line is added', async () => {
  const persona = (text) => ev('tool_call', { name: 'search_papers', arguments: { query: 'EPR spin labels' } }) + ev('token', { content: text }) +
    ev('done', { finish_reason: 'stop', usage: { prompt_tokens: 300, completion_tokens: 40 } });
  const bodies = await exportTurn({
    openai: [oaTool('d1', 'delegate', args({ label: 'Find spin label papers', task: 'Find two papers on EPR spin labels.', search: true })), oaText('Found two papers; checking their DOIs next.')],
    munin: [persona('Answer: Smith 2020, doi 10.1234/epr.2020.5; Lee 2021, https://doi.org/10.5555/LEE21.')],
  }, 'Find papers');
  assert.strictEqual(bodies.munin.length, 1);
  assert.strictEqual(bodies.munin[0].persona, 'research');
  const r = resultOf('d1');
  assert.strictEqual(r._agent.status, 'ok');
  assert.strictEqual(r._agent.full, `Answer: Smith 2020, doi 10.1234/epr.2020.5${T.UNVERIFIED_MARK}; Lee 2021, https://doi.org/10.5555/LEE21${T.UNVERIFIED_MARK}.`);
  assert.strictEqual(r._agent.unverified, 2);
  assert.ok(r.content.includes(`\n${T.RESEARCH_DOI_NOTE}\n`), r.content);
  deq(r._agent.log, [{ name: 'search_papers', summary: 'EPR spin labels', status: 'ok' }]);
});

test('7. A tool-loop agent: a DOI and a URL found in its tool results pass, invented ones are marked (case and prefix normalized)', async () => {
  await exportTurn({
    openai: [oaTool('d1', 'delegate', args()), oaText('One reference is real.')],
    munin: [muTool('m1', 'read_document', { scope: { start: 1, end: 11 }, include: ['text'], doc: null }),
      muText('Findings: L7 cites https://doi.org/10.1000/ABC.1 and 10.1000/abc.1; also 10.9999/made.up and https://example.org/paper.')],
  }, 'Check the references');
  const r = resultOf('d1');
  assert.strictEqual(r._agent.full, `Findings: L7 cites https://doi.org/10.1000/ABC.1 and 10.1000/abc.1; also 10.9999/made.up${T.UNVERIFIED_MARK} and https://example.org/paper${T.UNVERIFIED_MARK}.`);
  assert.strictEqual(r._agent.unverified, 2);
  assert.ok(!r.content.includes(T.RESEARCH_DOI_NOTE), 'the check line is for the research agent only');
  assert.ok(r.content.includes(`10.9999/made.up${T.UNVERIFIED_MARK}`));
});

test('8. Manual mode: the agent edits as in Auto, its write asks on a card first; after Allow the edit lands and the main model is told', async () => {
  const turn = apiTurn({
    openai: [oaTool('d1', 'delegate', args({ task: 'Capitalize gamma.' })), oaText('An agent capitalizes gamma.'), oaText('The agent capitalized gamma.')],
    munin: [muTool('m1', 'replace_text', { old_text: 'beta gamma', new_text: 'beta GAMMA' }), muText('Answer: done.\nEdits made: "beta gamma" -> "beta GAMMA".')],
  }, 'Capitalize gamma', 'manual');
  await waitFor(() => T.pendingPreviews.size === 1, 'the agent\'s card');
  assert.ok(!fake.log.some((x) => x.method === 'POST'), 'nothing written while the card waits');
  T.decidePreview([...T.pendingPreviews.keys()][0], 'accept');
  const bodies = await turn;
  assert.ok(fake.text('t.0').includes('Alpha beta GAMMA.'));
  const r = resultOf('d1');
  assert.strictEqual(r._agent.status, 'ok');
  assert.strictEqual(r._agent.edits.length, 1);
  assert.ok(reportIn(bodies.openai[2]).includes('The agent edited the document: '));
});

test('9. An agent\'s API error: status error, no answer passed on, the main model goes on', async () => {
  await exportTurn({
    openai: [oaTool('d1', 'delegate', args()), oaText('The agent failed; I read Methods myself: it cites one DOI.')],
    munin: [() => ({ ok: false, status: 400, text: async () => '{"error":{"message":"bad request"}}', headers: { get: () => null } })], // not retried (a 5xx is, after a delay)
  }, 'Check Methods');
  const r = resultOf('d1');
  assert.strictEqual(r._agent.status, 'error');
  assert.ok(r.content.startsWith('[Report of agent Check the Methods section and report. (a1, status error)]\nThe agent failed: ') && !r.content.includes('Agent result'), r.content);
  deq(shape(), ['u', 'a+delegate', 't:started', 'a', 'r:error', 'a']);
});

test('10. After a reload the chat shows the same order: the user, the started answer, the agent block at its report, the answer', async () => {
  await exportTurn({
    openai: [oaTool('d1', 'delegate', args({ label: 'Check Methods' })), oaText('An agent checks Methods.'), oaText('Methods is fine.')],
    munin: [muText('Answer: fine.')],
  }, 'Check Methods');
  T.el.chat.children.length = 0;
  T.renderHistory();
  const kinds = T.el.chat.children.map((c) => (c.classList.contains('agent-block') ? 'agent' : c.classList.contains('user') ? 'user' : c.classList.contains('assistant') ? 'assistant' : String(c.className)));
  deq(kinds, ['user', 'assistant', 'agent', 'assistant']);
  // the delegate round had no text: no bubble of its own; the block is the only element of the agent
  assert.strictEqual(T.el.chat.children.filter((c) => c.classList.contains('tool-card')).length, 0);
});

test('11. Two edit agents on overlapping lines: the second is refused while the first runs; only the first one\'s edit lands', async () => {
  await apiTurn({
    openai: [
      oaTool('d1', 'delegate', args({ task: 'Capitalize "gamma".', scope: [4, 5] })),
      oaTool('d2', 'delegate', args({ task: 'Capitalize "delta".', scope: [5, 6] })),
      oaText('One agent works; I will do delta after its report.'),
      oaText('Gamma is done.'),
    ],
    munin: [
      // the first agent writes only after the second delegate call was answered (it still runs then)
      async (b) => {
        if (b.messages.some((m) => m.role === 'tool')) return muText('Done.');
        await waitFor(() => state.messages.some((m) => m.tool_call_id === 'd2'), 'the second delegate call');
        return muTool('m1', 'replace_text', { old_text: 'beta gamma', new_text: 'beta GAMMA' });
      },
    ],
  }, 'Capitalize both with agents');
  const t = fake.text('t.0');
  assert.ok(t.includes('Alpha beta GAMMA.') && t.includes('Alpha beta delta.'), t);
  deq([resultOf('d1')._agent.status, resultOf('d2')._agent.status], ['ok', 'refused']);
  assert.strictEqual(resultOf('d2').content, 'Agent status: refused\nAgent a1 already edits lines 4–5: give this agent other lines or make it read-only.');
  deq(shape(), ['u', 'a+delegate', 't:started', 'a+delegate', 't:refused', 'a', 'r:ok', 'a']);
});

test('12. Plan mode: an agent asked to edit runs read-only; it has no writing tools and the document is unchanged', async () => {
  const bodies = await apiTurn({
    openai: [oaTool('d1', 'delegate', args({ task: 'Capitalize gamma.', access: 'edit', scope: [4, 4] })), oaText('A reader checks.'), oaText('Here is the plan.')],
    munin: [muTool('m1', 'replace_text', { old_text: 'beta gamma', new_text: 'beta GAMMA' }), muText('Blocked: I cannot edit.')],
  }, 'Plan the capitalization', 'plan');
  const started = state.messages.find((m) => m.tool_call_id === 'd1');
  assert.ok(started.content.startsWith('Agent "Capitalize gamma." started (id a1, read).'), started.content);
  const tools = (bodies.munin[0].tools || []).map((x) => x.function ? x.function.name : x.name);
  assert.ok(tools.includes('read_document') && !tools.includes('replace_text') && !tools.includes('remember'), tools.join(', '));
  assert.ok(bodies.munin[0].messages[1].content.includes('\n\nAccess: read-only; you cannot edit the document.\n'));
  assert.ok(fake.text('t.0').includes('Alpha beta gamma.'));
  assert.ok(!fake.log.some((x) => x.method === 'POST'));
  deq([resultOf('d1')._agent.access, resultOf('d1')._agent.edits.length], ['read', 0]);
});
