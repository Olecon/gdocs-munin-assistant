'use strict';
// Web search for /research: request bodies, the OpenAI and Anthropic stream items, full /research turns.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, makeSnapFor, installDocTab } = require('./lib/sandbox');
const { sseResponse, ev, tu, msgStart, stopTool, textRound } = require('./lib/streams');

let env, T, D, C2, state, PROVIDERS, sandbox, chrome, snapFor, READ_SET, wsSse, srvStart, srvResult, aBodies, hist,
    res;

before(async () => {
  env = await load();
  T = D = C2 = env.T;
  state = env.state;
  PROVIDERS = env.PROVIDERS;
  sandbox = env.ctx;
  chrome = env.chrome;
  snapFor = makeSnapFor(env);
  installDocTab(env);
  await T.refreshContext({ force: true });
});

test('web search: /research request bodies (OpenAI, Anthropic new/old models), other turns and Munin unchanged', async () => {
  // --- web search: request bodies (/research gets the tool, other turns do not; Munin unchanged)
  READ_SET = ['get_outline', 'read_lines', 'find_in_document', 'get_selection', 'open_document', 'remember', 'ask_user'];
  state.docFormat = 'markdown'; state.docText = '# Doc\n\nText.'; state.docModel = null; state.selection = '';
  let wreq = T.buildRequest('research', snapFor('openai', { model: 'gpt-6.1-sol' }));
  deq(wreq.body.tools.map((t) => t.name || t.type), [...READ_SET, 'web_search']); // reading tools first, then the search
  assert.ok(wreq.body.instructions.includes('You can search the web with the web_search tool') && wreq.body.instructions.includes('[title](url)'));
  assert.strictEqual(T.buildRequest('edit', snapFor('openai')).body.tools.some((t) => t.type === 'web_search'), false);
  assert.strictEqual(T.buildRequest('code', snapFor('openai')).body.tools.some((t) => t.type === 'web_search'), false);
  wreq = T.buildRequest('research', snapFor('anthropic', { model: 'claude-haiku-4-5', baseUrl: '' }));
  deq(wreq.body.tools.slice(-1), [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }]); // older model: no dynamic filtering
  assert.ok(wreq.body.system[0].text.includes('You can search the web with the web_search tool'));
  wreq = T.buildRequest('research', snapFor('anthropic', { model: 'claude-opus-5-5' }));
  deq(wreq.body.tools.slice(-1), [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }]);
  assert.ok(!T.buildRequest('edit', snapFor('anthropic')).body.tools.some((t) => t.name === 'web_search'));
  assert.ok(!T.buildRequest('manual', snapFor('anthropic')).body.system[0].text.includes('web_search'));
  wreq = T.buildRequest('research', snapFor('munin'));
  assert.strictEqual(wreq.kind, 'persona'); deq(Object.keys(wreq.body), ['model', 'persona', 'messages']);
  assert.ok(!wreq.body.messages[0].content.includes('web_search tool'));
});

test('OpenAI web search stream: rows, sources (deduplicated, http(s) only), items kept for replay', async () => {
  // --- OpenAI stream: web_search_call items (rows), url_citation annotations (sources), replay items
  const wsItem = { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'lipid rafts 2026' } };
  const wsOpen = { type: 'web_search_call', id: 'ws_2', status: 'completed', action: { type: 'open_page', url: 'https://example.org/b' } };
  const wsMsg = { type: 'message', id: 'msg_w', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'See [Page B](https://example.org/b).', annotations: [
    { type: 'url_citation', start_index: 4, end_index: 34, url: 'https://example.org/b', title: 'Page B' },
    { type: 'url_citation', start_index: 4, end_index: 34, url: 'https://example.org/b', title: 'Page B' },
    { type: 'url_citation', start_index: 0, end_index: 1, url: 'javascript:alert(1)', title: 'bad' },
    { type: 'url_citation', start_index: 0, end_index: 1, url: 'https://example.org/c', title: '' }] }] };
  wsSse = ev('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { type: 'web_search_call', id: 'ws_1', status: 'in_progress' } }) +
    ev('response.web_search_call.searching', { type: 'response.web_search_call.searching', output_index: 0, item_id: 'ws_1' }) +
    ev('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: wsItem }) +
    ev('response.output_item.done', { type: 'response.output_item.done', output_index: 1, item: wsOpen }) +
    ev('response.output_text.delta', { type: 'response.output_text.delta', output_index: 2, delta: 'See [Page B](https://example.org/b).' }) +
    ev('response.output_text.annotation.added', { type: 'response.output_text.annotation.added', output_index: 2, annotation: wsMsg.content[0].annotations[0] }) +
    ev('response.completed', { type: 'response.completed', response: { status: 'completed', output: [wsItem, wsOpen, wsMsg], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } });
  sandbox.fetch = async () => sseResponse(wsSse);
  const wsSnap = snapFor('openai', { model: 'gpt-6.1-sol' });
  const actSeen = [];
  res = await T.streamResponses(T.buildRequest('research', wsSnap), new AbortController().signal, wsSnap, { onActivity: (l) => actSeen.push(JSON.parse(JSON.stringify(l))) });
  deq(actSeen, [[{ name: 'web_search', summary: '' }], [{ name: 'web_search', summary: 'lipid rafts 2026' }], [{ name: 'web_search', summary: 'lipid rafts 2026' }, { name: 'open_page', summary: 'https://example.org/b' }]]);
  deq(res.activity, [{ name: 'web_search', summary: 'lipid rafts 2026' }, { name: 'open_page', summary: 'https://example.org/b' }]);
  deq(res.sources, [{ url: 'https://example.org/b', title: 'Page B' }, { url: 'https://example.org/c', title: '' }]);
  deq(res.raw.items, [wsItem, wsOpen, wsMsg]);
  assert.strictEqual(res.content, 'See [Page B](https://example.org/b).'); assert.strictEqual(res.finishReason, 'stop');
  deq(C2.openaiSources([]), []);
});

test('OpenAI /research turn: activity rows and Sources list, live and from the history', async () => {
  // --- OpenAI /research turn through sendMessage: rows and sources rendered, stored on the message
  state.settings.provider = 'openai'; state.googleConnected = false;
  chrome.tabs.sendMessage = async (id, msg) => (msg.type === 'GET_DOC_TEXT' ? { ok: true, text: '# Doc\n\nText.\n', format: 'markdown', title: 'My Doc' } : { ok: true, text: '', title: 'My Doc' });
  sandbox.fetch = async () => sseResponse(wsSse);
  await D.createChat();
  T.el.chat.children.length = 0;
  T.el.input.value = '/research lipid rafts';
  await T.sendMessage();
  hist = state.messages;
  assert.strictEqual(hist.length, 2); assert.strictEqual(hist[0]._persona, 'research');
  deq(hist[1]._toolActivity, [{ name: 'web_search', summary: 'lipid rafts 2026' }, { name: 'open_page', summary: 'https://example.org/b' }]);
  deq(hist[1]._sources, [{ url: 'https://example.org/b', title: 'Page B' }, { url: 'https://example.org/c', title: '' }]);
  assert.strictEqual(hist[1]._openaiItems, undefined); // final round: nothing to replay
  const SOURCES_HTML = '<div class="sources-title">Sources</div><ol><li><a href="https://example.org/b" target="_blank" rel="noopener noreferrer" title="https://example.org/b">Page B</a></li>' +
    '<li><a href="https://example.org/c" target="_blank" rel="noopener noreferrer" title="https://example.org/c">example.org</a></li></ol>'; // no title: the host
  const srcBubbles = () => T.el.chat.children.filter((c) => c._parts && c._parts.sources);
  deq(srcBubbles().map((b) => b._parts.sources.innerHTML), [SOURCES_HTML, SOURCES_HTML]); // live, then renderHistory at the end of the turn
  deq(srcBubbles()[1]._rows.map((r) => [r.tagName, r.className, r.innerHTML]), [
    ['div', 'activity-row', '🔍 <span class="activity-name">web_search</span>: lipid rafts 2026'],
    ['div', 'activity-row', '🌐 <span class="activity-name">open_page</span>: https://example.org/b'],
  ]);
});

test('Anthropic /research turn: server tool blocks replayed, pause_turn sent back, citations -> Sources, rows, search count', async () => {
  // --- Anthropic /research turn: server_tool_use + web_search_tool_result + client tool in one round,
  //     a pause_turn round sent back as it is, a final text with citations
  state.settings.provider = 'anthropic';
  Object.assign(state.settings.providers.anthropic, { apiKey: 'sk-ant-NEW', model: 'claude-opus-5-5', baseUrl: 'https://api.anthropic.com/v1' });
  srvStart = (index, id, query) => ev('content_block_start', { type: 'content_block_start', index, content_block: { type: 'server_tool_use', id, name: 'web_search' } }) +
    ev('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ query }) } }) +
    ev('content_block_stop', { type: 'content_block_stop', index });
  srvResult = (index, id, content) => ev('content_block_start', { type: 'content_block_start', index, content_block: { type: 'web_search_tool_result', tool_use_id: id, content } }) +
    ev('content_block_stop', { type: 'content_block_stop', index });
  const results1 = [{ type: 'web_search_result', url: 'https://example.org/a', title: 'Paper A', encrypted_content: 'ENC1', page_age: 'May 1, 2026' }];
  const errResult = { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' };
  const citation = { type: 'web_search_result_location', url: 'https://example.org/a', title: 'Paper A', encrypted_index: 'EI1', cited_text: 'Rafts are ordered domains.' };
  const aRounds = [
    msgStart + ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Searching.' } }) + ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      srvStart(1, 'srvtoolu_1', 'lipid rafts 2026') + srvResult(2, 'srvtoolu_1', results1) + tu(3, 'toolu_rl', 'read_lines', { start: 1, end: 1 }) + stopTool,
    msgStart + srvStart(0, 'srvtoolu_2', 'lipid rafts review') + srvResult(1, 'srvtoolu_2', errResult) +
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'pause_turn' }, usage: { output_tokens: 4 } }) + ev('message_stop', { type: 'message_stop' }),
    msgStart + ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'citations_delta', citation } }) +
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Rafts are ordered domains.' } }) + ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6, server_tool_use: { web_search_requests: 2 } } }) + ev('message_stop', { type: 'message_stop' }),
  ];
  aBodies = [];
  sandbox.fetch = async (url, init) => { aBodies.push(JSON.parse(init.body)); return sseResponse(aRounds[aBodies.length - 1]); };
  await D.createChat();
  T.el.chat.children.length = 0;
  T.el.input.value = '/research lipid rafts';
  await T.sendMessage();
  assert.strictEqual(aBodies.length, 3);
  deq(aBodies[0].tools.map((t) => t.name), [...READ_SET, 'web_search']);
  deq(aBodies[0].tools[7], { type: 'web_search_20260209', name: 'web_search', max_uses: 5 });
  assert.ok(aBodies[0].system[0].text.includes('You can search the web with the web_search tool'));
  const ROUND0_BLOCKS = [
    { type: 'text', text: 'Searching.' },
    { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'lipid rafts 2026' } },
    { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: results1 },
    { type: 'tool_use', id: 'toolu_rl', name: 'read_lines', input: { start: 1, end: 1 } },
  ];
  deq(aBodies[1].messages[1], { role: 'assistant', content: ROUND0_BLOCKS }); // raw blocks replayed in the second round
  assert.strictEqual(aBodies[1].messages[2].content[0].tool_use_id, 'toolu_rl');
  const PAUSED_BLOCKS = [{ type: 'server_tool_use', id: 'srvtoolu_2', name: 'web_search', input: { query: 'lipid rafts review' } }, { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_2', content: errResult }];
  assert.strictEqual(aBodies[2].messages.length, 4);
  deq(aBodies[2].messages[3], { role: 'assistant', content: PAUSED_BLOCKS }); // the paused turn goes back unchanged, last
  // feat/context: the round-2 cache breakpoint was on the last block (the tool result); the paused message is
  // last now and ends with a web_search_tool_result block, which gets none
  const round1 = JSON.parse(JSON.stringify(aBodies[1].messages));
  deq(round1[2].content[0].cache_control, { type: 'ephemeral' }); delete round1[2].content[0].cache_control;
  deq(aBodies[2].messages.slice(0, 3), round1);
  hist = state.messages;
  assert.strictEqual(hist.length, 5);
  deq(hist[1]._toolActivity, [{ name: 'web_search', summary: 'lipid rafts 2026' }]); assert.strictEqual(hist[1]._anthropicBlocks, undefined); // replayed above; dropped after the turn
  deq(hist[3]._toolActivity, [{ name: 'web_search', summary: 'lipid rafts review (failed: max_uses_exceeded)' }]); assert.strictEqual(hist[3]._anthropicBlocks, undefined);
  assert.strictEqual(hist[3].content, null); assert.strictEqual(hist[3].tool_calls, undefined);
  assert.strictEqual(hist[4].content, 'Rafts are ordered domains.');
  deq(hist[4]._sources, [{ url: 'https://example.org/a', title: 'Paper A' }]);
  assert.strictEqual(hist[4]._usage.web_search_requests, 2); assert.strictEqual(hist[4]._anthropicBlocks, undefined);
  T.el.chat.children.length = 0;
  T.renderHistory();
  const aBubbles = T.el.chat.children.filter((c) => c._parts);
  deq(aBubbles.map((b) => b._rows.map((r) => r.className)), [['activity-row', 'activity-row log-row ok'], ['activity-row'], []]);
  deq(aBubbles.map((b) => b._rows.map((r) => r.innerHTML.split('</span>')[1].split('<')[0])), [[': lipid rafts 2026', ': lines 1–1'], [': lipid rafts review (failed: max_uses_exceeded)'], []]);
  assert.strictEqual(aBubbles[2]._parts.sources.innerHTML, '<div class="sources-title">Sources</div><ol><li><a href="https://example.org/a" target="_blank" rel="noopener noreferrer" title="https://example.org/a">Paper A</a></li></ol>');
  assert.ok(aBubbles[2]._parts.meta.title.includes('Web searches: 2'));
  // the status line counts the searches of the turn
  C2.noteSearchActivity({ prov: PROVIDERS.anthropic, searchesDone: 1 }, [{ name: 'web_search' }, { name: 'open_page' }]);
  assert.strictEqual(T.el.docStatus.textContent, 'Anthropic (Claude) /research is searching the web… (2 searches)');
  deq(C2.anthropicSources([{ type: 'text', text: 'x', citations: [citation, { ...citation }, { type: 'char_location', cited_text: 'no url' }] }]), [{ url: 'https://example.org/a', title: 'Paper A' }]);
});

test('pause_turn continuations stop at the tool-round limit', async () => {
  // --- pause_turn is bounded by the tool-round limit
  const pauseOnly = msgStart + srvStart(0, 'srvtoolu_p', 'q') + srvResult(1, 'srvtoolu_p', []) +
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'pause_turn' }, usage: { output_tokens: 1 } }) + ev('message_stop', { type: 'message_stop' });
  aBodies.length = 0;
  sandbox.fetch = async (url, init) => { aBodies.push(JSON.parse(init.body)); return sseResponse(pauseOnly); };
  await D.createChat();
  T.el.chat.children.length = 0;
  T.el.input.value = '/research forever';
  await T.sendMessage();
  assert.strictEqual(aBodies.length, 13); // the first request + 12 continuations
  assert.ok(T.el.chat.children.some((c) => c.className.includes('notice') && c.innerHTML === 'The reply ended early (pause_turn).'));
});

test('search and a client tool in one Anthropic response: the search block is replayed with the tool result', async () => {
  // --- a web search and a client tool in the same Anthropic response (stop_reason tool_use): the search
  //     block goes back without a result, together with the tool result, in the next request
  const mixRounds = [
    msgStart + srvStart(0, 'srvtoolu_m', 'membrane lipids') + tu(1, 'toolu_mx', 'read_lines', { start: 1, end: 1 }) + stopTool,
    textRound('Done.'),
  ];
  aBodies.length = 0;
  sandbox.fetch = async (url, init) => { aBodies.push(JSON.parse(init.body)); return sseResponse(mixRounds[aBodies.length - 1]); };
  await D.createChat();
  T.el.chat.children.length = 0;
  T.el.input.value = '/research membranes';
  await T.sendMessage();
  assert.strictEqual(aBodies.length, 2);
  deq(aBodies[1].messages[1], { role: 'assistant', content: [
    { type: 'server_tool_use', id: 'srvtoolu_m', name: 'web_search', input: { query: 'membrane lipids' } },
    { type: 'tool_use', id: 'toolu_mx', name: 'read_lines', input: { start: 1, end: 1 } },
  ] });
  assert.strictEqual(aBodies[1].messages[2].role, 'user'); assert.strictEqual(aBodies[1].messages[2].content[0].tool_use_id, 'toolu_mx');
  deq(state.messages[1]._toolActivity, [{ name: 'web_search', summary: 'membrane lipids' }]);
  assert.strictEqual(state.messages[state.messages.length - 1].content, 'Done.');
});
