'use strict';
// Web search in ordinary turns (OpenAI, Anthropic): which requests carry the provider's web_search tool and the note in
// the head, which do not (Munin, the self-test's loops, document passes, the chat title, the summary and the section
// revision requests), and the taint a search leaves on an Auto turn.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { load, makeSnapFor, waitFor } = require('./lib/sandbox');
const { ev } = require('./lib/streams');
const { docBench, providerRouter, useProvider, send, oaText } = require('./lib/context');

let env, T, state, doc, snapFor;
const NOTE = 'You can search the web with the web_search tool';
const searchTool = (body) => (body.tools || []).some((t) => t.type === 'web_search' || t.name === 'web_search');
const headOf = (req) => (req.kind === 'responses' ? req.body.instructions : req.kind === 'anthropic' ? req.body.system[0].text : req.body.messages[0].content);

before(async () => {
  env = await load();
  ({ T, state } = env);
  ({ doc } = docBench(env));
  snapFor = makeSnapFor(env);
  await T.refreshContext({ force: true });
  state.docText = '# Doc\n\nAlpha beta gamma.'; state.docFormat = 'markdown'; state.docModel = null; state.selection = '';
});

test('Auto, Manual, Plan and /side on OpenAI and Anthropic carry web_search and the note; Munin does not', () => {
  for (const prov of ['openai', 'anthropic']) {
    for (const mode of ['edit', 'manual', 'plan']) {
      const req = T.buildRequest(mode, snapFor(prov));
      assert.ok(searchTool(req.body), `${prov} ${mode}`);
      assert.ok(headOf(req).includes(NOTE), `${prov} ${mode}: the note`);
      assert.strictEqual(headOf(req).split(NOTE).length, 2, `${prov} ${mode}: the note once`);
    }
    const side = T.buildRequest('manual', { ...snapFor(prov), side: true });
    assert.ok(searchTool(side.body), `${prov} /side`);
  }
  // The note follows the reading section and comes before the mode's rules.
  const h = headOf(T.buildRequest('edit', snapFor('openai')));
  assert.ok(h.indexOf('Reading results from earlier messages become "content omitted"') < h.indexOf(NOTE));
  assert.ok(h.indexOf(NOTE) < h.indexOf(T.TOOLS_EDIT_RULES.slice(0, 40)));
  for (const mode of ['edit', 'manual', 'plan']) {
    const req = T.buildRequest(mode, snapFor('munin'));
    assert.ok(!searchTool(req.body), `munin ${mode}`);
    assert.ok(!headOf(req).includes('web_search'), `munin ${mode}: no note`);
  }
});

test('no web_search in the self-test\'s loops, the probe, document passes or an agent without search', () => {
  for (const prov of ['openai', 'anthropic']) {
    const quiet = T.buildRequest('edit', { ...snapFor(prov), quiet: true });
    assert.ok(!searchTool(quiet.body) && !headOf(quiet).includes(NOTE), `${prov}: a quiet loop`);
    const probe = T.buildRequest('manual', snapFor(prov), { history: [{ role: 'user', content: 'Say OK' }], noTools: true });
    assert.ok(!searchTool(probe.body), `${prov}: the probe`);
    for (const mode of ['review', 'card', 'coverage']) assert.ok(!searchTool(T.buildRequest(mode, snapFor(prov)).body), `${prov} ${mode}`);
    const agent = { ...snapFor(prov), agent: { task: 'x' }, agentSearch: false };
    assert.ok(!searchTool(T.buildRequest('manual', agent).body) && !headOf(T.buildRequest('manual', agent)).includes(NOTE), `${prov}: agent without search`);
    const searching = { ...snapFor(prov), agent: { task: 'x' }, agentSearch: true, quiet: true };
    assert.ok(searchTool(T.buildRequest('manual', searching).body), `${prov}: an agent with search, also from a quiet turn`);
  }
});

test('no web_search in the chat title, summary and section revision requests', () => {
  for (const prov of ['openai', 'anthropic', 'munin']) {
    const s = snapFor(prov);
    for (const req of [T.chatTitleRequest(s, 'hi'), T.buildSummaryRequest(s, 'user: hi'), T.reviseRequest(s, 'Revise.', 'Text.')]) {
      assert.strictEqual(req.body.tools, undefined, `${prov} ${req.kind}`);
      assert.strictEqual(req.tools.length, 0);
    }
  }
});

test('a web search (OpenAI) taints the turn: the following write\'s card in Manual says so', async () => {
  useProvider(env, 'openai', { model: 'gpt-6.1-sol' });
  env.state.applyMode = 'manual'; // every write asks (Auto shows no card for a document edit, in a tainted turn too)
  doc.text = '# Doc\n\nAlpha beta gamma.'; doc.selection = 'Alpha beta gamma.';
  await T.createChat();
  T.el.chat.children.length = 0;
  const ws = { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'lipid rafts' } };
  const fc = { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'replace_selection', arguments: JSON.stringify({ text: 'Alpha, revised.' }), status: 'completed' };
  const searchAndWrite = ev('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: ws }) +
    ev('response.output_item.done', { type: 'response.output_item.done', output_index: 1, item: fc }) +
    ev('response.completed', { type: 'response.completed', response: { status: 'completed', output: [ws, fc], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } });
  const { bodies, fetch } = providerRouter({ openai: [searchAndWrite, oaText('Done.')] });
  env.ctx.fetch = fetch;
  const turn = send(env, 'Rewrite this with a recent source');
  await waitFor(() => T.pendingPreviews.size === 1, 'the edit card of the tainted turn');
  const [[id, p]] = [...T.pendingPreviews.entries()];
  assert.ok(p.card.innerHTML.includes('Earlier in this answer the assistant read text that may carry instructions'));
  T.decidePreview(id, 'reject');
  await turn;
  assert.ok(searchTool(bodies.openai[0]));
  const toolMsg = [...state.messages].reverse().find((m) => m.role === 'tool');
  assert.strictEqual(toolMsg._decision, 'rejected');
});
