'use strict';
// The agents pill and the agent map on a real DOM (src/agent-map.js): "N agents" right of the mode button (muted with
// none, the dot pulsing while one runs), the map with one row per agent of the document (newest first: label, status
// dot, model, duration, tokens; Stop on a running row), the detail of one agent (back arrow, status line, Prompt,
// Tool calls, Report as Markdown), Escape and a press outside closing it.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { load, click, key, tick } = require('../lib/dom-sandbox');
const { installDocTab, waitFor } = require('../lib/sandbox');
const { providerRouter, oaTool, oaText } = require('../lib/context');

let env, T, state, el, document;
const cc = (o) => `data: ${JSON.stringify(o)}\n\n`;
const muText = (t) => cc({ choices: [{ index: 0, delta: { content: t } }] }) + cc({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n';
const NOW = Date.now();
const STORED = [
  { id: 'a1', chatId: 'x', label: 'Check the Methods numbers', task: 'Check every number in Methods.', context: 'The user wants exact values.', model: 'Munin/qwen3.8-27b', search: false,
    status: 'ok', startedAt: NOW - 488000, endedAt: NOW, usage: { prompt_tokens: 90000, completion_tokens: 1300 }, rounds: 3,
    log: [{ name: 'read_lines', summary: 'lines 5–7', status: 'ok' }, { name: 'find_text', summary: '"n ="', status: 'ok' }],
    report: '[Report of agent …]', full: 'Answer: **two** numbers differ.\n\n- L5: 48 vs 52', delivered: true },
  { id: 'a2', chatId: 'x', label: 'Search lipid rafts', task: 'Find papers.', context: '', model: 'OpenAI/gpt-6.1-sol', search: true,
    status: 'error', startedAt: NOW - 5000, endedAt: NOW, usage: null, rounds: 0, log: [], report: '', full: '', delivered: true },
];

before(async () => {
  env = await load({ storage: { 'muninAgents:DOC123': STORED } });
  ({ T, state, el, document } = env);
  installDocTab(env);
  env.chrome.tabs.sendMessage = async (id, msg) => {
    switch (msg.type) {
      case 'PING': return { ok: true, title: 'My Doc' };
      case 'GET_SELECTION': return { ok: true, text: '' };
      case 'GET_DOC_TEXT': return { ok: true, text: '# My Doc\n\n## Methods\n\nAlpha line.', format: 'markdown', title: 'My Doc' };
      default: return { ok: true };
    }
  };
  await T.refreshContext({ force: true });
  await waitFor(() => state.agents.length === 2, 'the registry');
  state.settings.provider = 'openai';
  state.settings.providers.openai.apiKey = 'sk-T';
  state.settings.providers.munin.apiKey = 'k-munin';
  state.googleConnected = false;
});
after(() => env.close());

const pill = () => document.getElementById('agentsBtn');
const map = () => document.getElementById('agentMap');
const rows = () => [...map().querySelectorAll('.agent-row')];

test('the pill: right of the mode button, "N agents" of the document, muted with none', async () => {
  assert.strictEqual(pill().previousElementSibling.id, 'modeCycle');
  assert.strictEqual(pill().nextElementSibling.id, 'chatModel');
  assert.ok(pill().classList.contains('mode-cycle') && pill().querySelector('.mode-dot'));
  assert.strictEqual(pill().querySelector('.mode-label').textContent, '2 agents');
  assert.ok(!pill().classList.contains('none') && !pill().classList.contains('running'));
  assert.strictEqual(pill().getAttribute('aria-label'), 'Agents of this document: 2 agents');
  assert.strictEqual(pill().dataset.tip, 'Agent map: 2 agents');
  assert.strictEqual(pill().disabled, false);
  // a document without agents: "0 agents", muted, disabled, no tooltip
  const saved = state.agents;
  state.agents = [];
  T.renderAgentsUi();
  assert.strictEqual(pill().querySelector('.mode-label').textContent, '0 agents');
  assert.ok(pill().classList.contains('none'));
  assert.strictEqual(pill().disabled, true);
  assert.strictEqual(pill().dataset.tip, undefined);
  click(pill());
  assert.ok(map().classList.contains('hidden'), 'a disabled pill opens nothing');
  state.agents = [saved[0]];
  T.renderAgentsUi();
  assert.strictEqual(pill().querySelector('.mode-label').textContent, '1 agent');
  assert.strictEqual(pill().disabled, false);
  assert.strictEqual(pill().dataset.tip, 'Agent map: 1 agent');
  // the last agent leaves while the map is open: an empty list, no text
  click(pill());
  assert.ok(!map().classList.contains('hidden'));
  state.agents = [];
  T.renderAgentsUi();
  assert.strictEqual(rows().length, 0);
  assert.strictEqual(map().textContent, '');
  assert.strictEqual(pill().disabled, true);
  key(map(), 'Escape');
  assert.ok(map().classList.contains('hidden'));
  state.agents = saved;
  T.renderAgentsUi();
});

test('the map: one row per agent, newest first, with the status dot, model, duration and tokens; Escape closes it', async () => {
  click(pill());
  assert.ok(!map().classList.contains('hidden'));
  assert.strictEqual(pill().getAttribute('aria-expanded'), 'true');
  deq(rows().map((r) => r.dataset.id), ['a2', 'a1']);
  const r1 = rows()[1];
  assert.strictEqual(r1.querySelector('.agent-row-title').textContent, 'Check the Methods numbers');
  assert.ok(r1.querySelector('.agent-dot').classList.contains('st-ok'));
  assert.strictEqual(r1.querySelector('.agent-row-meta').textContent, 'Munin/qwen3.8-27b · 8m 8s · 91.3k tokens');
  assert.strictEqual(rows()[0].querySelector('.agent-row-meta').textContent, 'OpenAI/gpt-6.1-sol · 5s');
  assert.ok(rows()[0].querySelector('.agent-dot').classList.contains('st-error'));
  assert.ok(!map().querySelector('.agent-row-stop'), 'no Stop on finished agents');
  assert.strictEqual(document.activeElement, rows()[0].querySelector('.agent-row-main'));
  key(document.activeElement, 'ArrowDown');
  assert.strictEqual(document.activeElement, rows()[1].querySelector('.agent-row-main'));
  key(document.activeElement, 'Escape');
  assert.ok(map().classList.contains('hidden'));
  assert.strictEqual(document.activeElement, pill());
  assert.strictEqual(pill().getAttribute('aria-expanded'), 'false');
});

test('the detail: back arrow, the label, the status line, Prompt (folded), Tool calls (N), the report as Markdown; back; a press outside closes', async () => {
  click(pill());
  click(rows()[1].querySelector('.agent-row-main'));
  const d = map().querySelector('.agent-detail');
  assert.ok(d);
  assert.strictEqual(d.querySelector('.agent-detail-title').textContent, 'Check the Methods numbers');
  assert.strictEqual(document.activeElement, d.querySelector('.agent-back'));
  assert.strictEqual(d.querySelector('.agent-back').getAttribute('aria-label'), 'Back to all agents');
  assert.strictEqual(d.querySelector('.agent-detail-status').textContent, 'done · Munin/qwen3.8-27b · 8m 8s · 91.3k tokens');
  const secs = [...d.querySelectorAll('details.agent-sec')];
  deq(secs.map((x) => [x.querySelector('summary').textContent, x.open]), [['Prompt', false], ['Tool calls (2)', false]]);
  assert.strictEqual(secs[0].querySelector('.agent-prompt').textContent, 'Check every number in Methods.\n\nContext: The user wants exact values.');
  assert.match(secs[1].textContent, /read_lines: lines 5–7.*find_text: "n ="/s);
  const report = d.querySelector('.agent-report');
  assert.strictEqual(report.querySelector('strong').textContent, 'two');
  assert.ok(report.querySelector('li').textContent.includes('L5: 48 vs 52'));
  // back to the list, the row focused again
  click(d.querySelector('.agent-back'));
  assert.ok(!map().querySelector('.agent-detail'));
  assert.strictEqual(document.activeElement, rows()[1].querySelector('.agent-row-main'));
  // a press outside closes it; a press inside does not
  map().querySelector('.agent-row').dispatchEvent(new env.window.MouseEvent('mousedown', { bubbles: true }));
  assert.ok(!map().classList.contains('hidden'));
  el.chat.dispatchEvent(new env.window.MouseEvent('mousedown', { bubbles: true }));
  assert.ok(map().classList.contains('hidden'));
});

test('a running agent: the pill pulses, its row ticks and has Stop, which stops only that agent; the detail shows its live tool calls', async () => {
  await T.createChat();
  let release;
  const gate = new Promise((r) => { release = r; });
  let started = 0;
  const r = providerRouter({
    // read agents: in Manual (the default mode) an agent edits by default, and two whole-document editors never run at once
    openai: [oaTool('d1', 'delegate', { label: 'Slow one', task: 'Check slowly.', context: null, model: 'munin', search: false, access: 'read' }),
      oaTool('d2', 'delegate', { label: 'Other one', task: 'Check the rest.', context: null, model: 'munin', search: false, access: 'read' }), oaText('Two agents work.'), oaText('Reported.')],
    munin: [async (b, init) => {
      started++;
      await new Promise((res, rej) => { gate.then(res); init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))); });
      return muText('Answer: fine.');
    }],
  });
  env.ctx.fetch = r.fetch;
  el.input.value = 'Check with two agents';
  await T.sendMessage();
  await waitFor(() => started === 2, 'both agents\' requests');
  assert.strictEqual(pill().querySelector('.mode-label').textContent, '4 agents');
  assert.ok(pill().classList.contains('running'));
  click(pill());
  deq(rows().map((x) => x.dataset.id), ['a4', 'a3', 'a2', 'a1']);
  const slow = rows().find((x) => x.dataset.id === 'a3');
  assert.ok(slow.querySelector('.agent-dot').classList.contains('st-running'));
  assert.ok(slow.querySelector('.agent-row-stop'));
  const time = slow.querySelector('.agent-time');
  assert.match(time.textContent, /^\ds$/);
  // the detail of a running agent: no report yet, Stop
  click(slow.querySelector('.agent-row-main'));
  assert.strictEqual(map().querySelector('.agent-report').textContent, 'The report arrives when the agent is done.');
  assert.ok(map().querySelector('.agent-detail-stop'));
  click(map().querySelector('.agent-back'));
  click(rows().find((x) => x.dataset.id === 'a3').querySelector('.agent-row-stop'));
  await waitFor(() => state.agents.find((e) => e.id === 'a3').status === 'stopped', 'a3 stopped');
  assert.strictEqual(state.agents.find((e) => e.id === 'a4').status, 'running');
  assert.ok(!rows().find((x) => x.dataset.id === 'a3').querySelector('.agent-row-stop'));
  release();
  await T.agentsSettled();
  assert.strictEqual(state.agents.find((e) => e.id === 'a4').status, 'ok');
  assert.ok(!pill().classList.contains('running'));
  await tick(5);
  key(map(), 'Escape');
});

test('the right in the map: "edit · lines 40–80" or "read" before the model, in the row and in the detail', async () => {
  const saved = state.agents;
  state.agents = [
    { ...STORED[0], id: 'a7', access: 'edit', scope: { start: 40, end: 80 } },
    { ...STORED[1], id: 'a8', access: 'read', scope: null },
  ];
  T.renderAgentsUi();
  click(pill());
  deq(rows().map((r) => r.dataset.id), ['a8', 'a7']);
  assert.strictEqual(rows()[1].querySelector('.agent-row-meta').textContent, 'edit · lines 40–80 · Munin/qwen3.8-27b · 8m 8s · 91.3k tokens');
  assert.strictEqual(rows()[0].querySelector('.agent-row-meta').textContent, 'read · OpenAI/gpt-6.1-sol · 5s');
  click(rows()[1].querySelector('.agent-row-main'));
  assert.strictEqual(map().querySelector('.agent-detail-status').textContent, 'done · edit · lines 40–80 · Munin/qwen3.8-27b · 8m 8s · 91.3k tokens');
  key(map(), 'Escape');
  state.agents = saved;
  T.renderAgentsUi();
});

function deq(a, b, m) { assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), m); }
