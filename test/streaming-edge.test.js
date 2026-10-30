'use strict';
// Streaming edge cases: a reader that fails after some chunks (partial result, no retry, the partial
// answer kept), a Stop mid-stream, Munin's persona event stream, the retries of runStream for the
// Responses and Chat Completions kinds, and the summary request of a compaction on transient errors.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { deq, load, makeSnapFor, installDocTab, waitFor, tabExportOnly } = require('./lib/sandbox');
const { sseResponse, ev, textRound } = require('./lib/streams');
const { liveStream, failingStream } = require('./lib/live-stream');

let env, T, state, sandbox, storage, chrome, PROVIDERS, snapFor, delays, savedDelays;
const chatTexts = (cls) => T.el.chat.children.filter((c) => c.className && c.className.includes(cls)).map((c) => c.innerHTML);

before(async () => {
  env = await load();
  ({ T, state, ctx: sandbox, storage, chrome, PROVIDERS } = env);
  snapFor = makeSnapFor(env);
  installDocTab(env);
  chrome.tabs.sendMessage = async (id, msg) => {
    if (msg.type === 'GET_SELECTION') return { ok: true, text: '' };
    if (msg.type === 'GET_DOC_TEXT') return { ok: true, text: '# Doc\n\nSome text.', format: 'markdown', title: 'My Doc' };
    return { ok: true, title: 'My Doc' };
  };
  await T.refreshContext({ force: true });
  state.googleConnected = false;
  delays = T.STREAM_RETRY_DELAYS_MS;
  savedDelays = delays.slice();
  delays.splice(0, delays.length, 5, 5); // fast retries
});
after(() => { delays.splice(0, delays.length, ...savedDelays); });

// Stream bodies of the three non-persona kinds: the beginning of a text answer (no end).
const openings = {
  anthropic: ev('message_start', { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 5 } } }) +
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Half an ' } }),
  openai: ev('response.created', { type: 'response.created', response: { id: 'r1' } }) +
    ev('response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Half an ' }),
  munin: 'data: {"id":"1","choices":[{"index":0,"delta":{"content":"Half an "}}]}\n\n',
};
const second = {
  anthropic: ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'answer' } }),
  openai: ev('response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'answer' }),
  munin: 'data: {"id":"1","choices":[{"index":0,"delta":{"content":"answer"}}]}\n\n',
};
const fullAnswer = {
  openai: ev('response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, delta: 'Fine.' }) +
    ev('response.completed', { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text: 'Fine.' }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }),
  munin: 'data: {"id":"1","choices":[{"index":0,"delta":{"content":"Fine."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
};

test('a reader that throws TypeError mid-stream: error with .partial, no retry (all three kinds)', async () => {
  for (const prov of ['anthropic', 'openai', 'munin']) {
    const snap = snapFor(prov);
    const req = T.buildRequest('edit', snap);
    let calls = 0;
    sandbox.fetch = async () => { calls++; return failingStream([openings[prov], second[prov]], new TypeError('network error')); };
    const seen = [];
    await assert.rejects(() => T.runStream(req, new AbortController().signal, snap, { onContent: (c) => seen.push(c) }), (e) => {
      assert.strictEqual(e.message, 'network error', prov);
      assert.ok(e.partial, prov + ': partial');
      assert.strictEqual(e.partial.content, 'Half an answer', prov);
      return true;
    });
    assert.strictEqual(calls, 1, prov + ': not retried once the stream started');
    assert.strictEqual(seen[seen.length - 1], 'Half an answer', prov);
  }
});

test('a turn whose stream breaks keeps the partial answer in the history and shows the error', async () => {
  state.settings.provider = 'anthropic';
  Object.assign(state.settings.providers.anthropic, { apiKey: 'sk-ant-x', model: 'claude-opus-5-5' });
  await T.createChat();
  let calls = 0;
  sandbox.fetch = tabExportOnly(async () => { calls++; return failingStream([openings.anthropic, second.anthropic], new TypeError('network error')); });
  T.el.chat.children.length = 0;
  T.el.input.value = 'Tell me';
  await T.sendMessage();
  assert.strictEqual(calls, 1);
  assert.strictEqual(state.busy, false);
  deq(state.messages.map((m) => [m.role, m.content]), [['user', 'Tell me'], ['assistant', 'Half an answer']]);
  deq(storage[`muninChatHistory:DOC123:${state.chatId}`].map((m) => m.content), ['Tell me', 'Half an answer']); // persisted
  assert.ok(chatTexts('error').includes('network error'));
  // one bubble for the partial answer after the re-render
  assert.strictEqual(T.el.chat.children.filter((c) => c.className === 'msg assistant').length, 1);
});

test('Stop mid-stream (OpenAI): the partial answer is kept, "Stopped." is shown, nothing retried', async () => {
  state.settings.provider = 'openai';
  Object.assign(state.settings.providers.openai, { apiKey: 'sk-x', model: 'gpt-6.1-sol' });
  await T.createChat();
  const stream = liveStream();
  let calls = 0;
  sandbox.fetch = tabExportOnly(async (url, init) => {
    calls++;
    init.signal.addEventListener('abort', () => stream.fail(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })));
    return stream.response;
  });
  T.el.chat.children.length = 0;
  T.el.input.value = 'Go';
  const turn = T.sendMessage();
  await waitFor(() => stream.reads > 0, 'the stream');
  stream.push(openings.openai + second.openai);
  await new Promise((r) => setTimeout(r, 20));
  state.abort.abort();
  await turn;
  assert.strictEqual(calls, 1);
  deq(state.messages.map((m) => [m.role, m.content]), [['user', 'Go'], ['assistant', 'Half an answer']]);
  assert.ok(chatTexts('notice').includes('Stopped.'));
  assert.strictEqual(chatTexts('error').length, 0);
  assert.strictEqual(state.abort, null);
});

test('Munin persona stream: thinking / token / tool_call / done; routing ignored; error and cut-off', async () => {
  const snap = snapFor('munin');
  const req = T.buildRequest('research', snap);
  assert.strictEqual(req.kind, 'persona');
  const pev = (name, data, id) => `id: s-${id}\nevent: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  const body = pev('routing', { persona: 'research' }, 1) + pev('conversation', { id: 'c1' }, 2) +
    pev('thinking', { content: 'Looking ' }, 3) + pev('thinking', { content: 'for papers.' }, 4) +
    pev('tool_call', { name: 'openalex_search', arguments: JSON.stringify({ query: 'lipid rafts' }) }, 5) +
    pev('tool_call', { name: 'fetch_url', arguments: { url: 'https://example.org/p' } }, 6) +
    pev('token', { content: 'Rafts are ' }, 7) + pev('token', { content: 'domains.' }, 8) + pev('token', { content: '' }, 9) +
    pev('mystery', { x: 1 }, 10) +
    pev('done', { usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }, terminal_reason: 'completed' }, 11);
  sandbox.fetch = async (url, init) => {
    const b = JSON.parse(init.body);
    assert.strictEqual(b.persona, 'research');
    assert.strictEqual(url, 'https://api.muninai.org/v1/chat/completions');
    return sseResponse(body);
  };
  const seen = { reasoning: [], content: [], activity: [] };
  const res = await T.streamPersona(req, new AbortController().signal, snap, {
    onReasoning: (r) => seen.reasoning.push(r), onContent: (c) => seen.content.push(c), onActivity: (a) => seen.activity.push(a.length),
  });
  deq(res, {
    content: 'Rafts are domains.', reasoning: 'Looking for papers.',
    activity: [{ name: 'openalex_search', summary: 'lipid rafts' }, { name: 'fetch_url', summary: 'https://example.org/p' }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }, finishReason: 'completed',
  });
  deq(seen, { reasoning: ['Looking ', 'Looking for papers.'], content: ['Rafts are ', 'Rafts are domains.'], activity: [1, 2] });
  // done without a reason -> 'stop'
  sandbox.fetch = async () => sseResponse(pev('token', { content: 'x' }, 1) + pev('done', {}, 2));
  assert.strictEqual((await T.streamPersona(req, new AbortController().signal, snap, {})).finishReason, 'stop');
  // an error event: the message, with the partial result
  sandbox.fetch = async () => sseResponse(pev('token', { content: 'Part' }, 1) + pev('error', { error: { message: 'model overloaded' } }, 2));
  await assert.rejects(() => T.streamPersona(req, new AbortController().signal, snap, {}),
    (e) => e.message === 'API error (persona stream): model overloaded' && e.partial.content === 'Part');
  sandbox.fetch = async () => sseResponse(pev('error', { message: 'plain message' }, 1));
  await assert.rejects(() => T.streamPersona(req, new AbortController().signal, snap, {}), /persona stream\): plain message/);
  // no "done": cut off
  sandbox.fetch = async () => sseResponse(pev('token', { content: 'Unfinished' }, 1));
  await assert.rejects(() => T.streamPersona(req, new AbortController().signal, snap, {}),
    (e) => e.message === 'The persona response stream was cut off' && e.partial.content === 'Unfinished');
});

test('Munin persona turn through sendMessage: activity, reasoning and usage stored; partial kept on a cut', async () => {
  state.settings.provider = 'munin';
  Object.assign(state.settings.providers.munin, { apiKey: 'mk-1' });
  await T.createChat();
  const pev = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  sandbox.fetch = async () => sseResponse(pev('thinking', { content: 'Hmm.' }) + pev('tool_call', { name: 'scholar_search', arguments: '{"q":"rafts"}' }) +
    pev('token', { content: 'Found **two** papers.' }) + pev('done', { usage: { total_tokens: 30, prompt_tokens: 20, completion_tokens: 10 } }));
  T.el.input.value = '/research rafts';
  await T.sendMessage();
  const last = state.messages[state.messages.length - 1];
  deq({ ...state.messages[0], _docFacts: undefined }, { role: 'user', content: 'rafts', _persona: 'research' }); // _docFacts: feat/context
  deq(last, { role: 'assistant', content: 'Found **two** papers.', _reasoning: 'Hmm.', _toolActivity: [{ name: 'scholar_search', summary: 'rafts' }], _usage: { total_tokens: 30, prompt_tokens: 20, completion_tokens: 10 } });
  // the stream is cut: the partial persona answer is kept and the error shown
  T.el.chat.children.length = 0;
  sandbox.fetch = async () => sseResponse(pev('token', { content: 'Partial persona' }));
  T.el.input.value = '/chat more';
  await T.sendMessage();
  assert.strictEqual(state.messages[state.messages.length - 1].content, 'Partial persona');
  assert.ok(chatTexts('error').includes('The persona response stream was cut off'));
});

test('runStream retries before the stream starts for kind "responses" and "chat" too', async () => {
  for (const prov of ['openai', 'munin']) {
    const snap = snapFor(prov);
    const req = T.buildRequest('edit', snap);
    assert.strictEqual(req.kind, prov === 'openai' ? 'responses' : 'chat');
    const errBody = (status) => sseResponse(JSON.stringify({ error: { message: 'busy' } }), status);
    // 503, then a failed connection, then the answer
    let calls = 0;
    sandbox.fetch = async () => {
      calls++;
      if (calls === 1) return errBody(503);
      if (calls === 2) throw new TypeError('Failed to fetch');
      return sseResponse(fullAnswer[prov]);
    };
    const res = await T.runStream(req, new AbortController().signal, snap, {});
    assert.strictEqual(calls, 3, prov);
    assert.strictEqual(res.content, 'Fine.', prov);
    // two retries at most
    calls = 0;
    sandbox.fetch = async () => { calls++; return errBody(503); };
    await assert.rejects(() => T.runStream(req, new AbortController().signal, snap, {}), (e) => e.status === 503);
    assert.strictEqual(calls, 3, prov);
    // 429: retried for OpenAI (rate limit), not for Munin (a monthly quota; feat/storage)
    calls = 0;
    sandbox.fetch = async () => { calls++; return errBody(429); };
    await assert.rejects(() => T.runStream(req, new AbortController().signal, snap, {}), (e) => e.status === 429);
    assert.strictEqual(calls, prov === 'openai' ? 3 : 1, prov);
    // not retried: 401
    calls = 0;
    sandbox.fetch = async () => { calls++; return errBody(401); };
    await assert.rejects(() => T.runStream(req, new AbortController().signal, snap, {}), (e) => e.status === 401 && e.showSettings);
    assert.strictEqual(calls, 1, prov);
  }
});

// The over-budget history of compaction.test.js: two big older turns and a small recent one.
function bigHistory() {
  const x = (c) => c.repeat(9000);
  return [
    { role: 'user', content: 'First: ' + x('a') }, { role: 'assistant', content: x('b') },
    { role: 'user', content: 'Second: ' + x('c') }, { role: 'assistant', content: x('e') },
    { role: 'user', content: 'third question' }, { role: 'assistant', content: 'third answer' },
  ];
}

test('compaction: the summary request is retried on a transient error and then succeeds', async () => {
  state.settings.provider = 'anthropic';
  Object.assign(state.settings.providers.anthropic, { apiKey: 'sk-ant-x', model: 'claude-opus-5-5' });
  const saved = PROVIDERS.anthropic.contextTokens;
  PROVIDERS.anthropic.contextTokens = 100; // budget: the 8,000-token floor
  try {
    for (const failure of ['529', 'network']) {
      await T.createChat();
      state.messages.push(...bigHistory());
      await T.saveHistory(); // a turn starts from the stored history
      const kinds = [];
      let summaryCalls = 0;
      sandbox.fetch = async (url, init) => {
        const b = JSON.parse(init.body);
        const isSummary = b.system === T.COMPACT_PROMPT;
        kinds.push(isSummary ? 'summary' : 'turn');
        if (isSummary && ++summaryCalls === 1) {
          if (failure === 'network') throw new TypeError('Failed to fetch');
          return sseResponse(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), 529);
        }
        return sseResponse(textRound(isSummary ? 'Summary text.' : 'Answer.'));
      };
      T.el.chat.children.length = 0;
      T.el.input.value = 'new question';
      await T.sendMessage();
      deq(kinds, ['summary', 'summary', 'turn'], failure);
      const summary = state.messages.find((m) => m._summary);
      assert.ok(summary && summary.content.endsWith('Summary text.'), failure);
      assert.strictEqual(state.compactionFailedChat, null);
      assert.ok(!chatTexts('notice').some((t) => t.startsWith('Could not summarize')));
    }
    // a summary stream that breaks after it started: no retry, the turn goes on with trimming
    await T.createChat();
    state.messages.push(...bigHistory());
    await T.saveHistory(); // a turn starts from the stored history
    const kinds = [];
    sandbox.fetch = async (url, init) => {
      const isSummary = JSON.parse(init.body).system === T.COMPACT_PROMPT;
      kinds.push(isSummary ? 'summary' : 'turn');
      return isSummary ? failingStream([openings.anthropic], new TypeError('network error')) : sseResponse(textRound('Answer.'));
    };
    T.el.chat.children.length = 0;
    T.el.input.value = 'new question';
    await T.sendMessage();
    deq(kinds, ['summary', 'turn']);
    assert.ok(!state.messages.some((m) => m._summary || m._compacted));
    assert.strictEqual(state.compactionFailedChat, state.chatId);
    assert.ok(chatTexts('notice').some((t) => t.startsWith('Could not summarize the earlier conversation (network error)')));
    assert.strictEqual(state.messages[state.messages.length - 1].content, 'Answer.');
  } finally {
    PROVIDERS.anthropic.contextTokens = saved;
  }
});
