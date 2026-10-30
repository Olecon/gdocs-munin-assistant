'use strict';
// Helpers of the feat/context tests (caching, document changes, slimming): a Docs tab whose document and
// selection the test changes between turns (export path, no Google account), a fetch recorder, SSE rounds
// for OpenAI and Munin (Anthropic rounds are in streams.js), and helpers to compare request prefixes.
const { installDocTab } = require('./sandbox');
const { sseResponse, ev } = require('./streams');

// The Docs tab (DOC123) and its content: doc.text (Markdown export), doc.selection, doc.title.
function docBench(env) {
  const tab = installDocTab(env);
  const doc = { text: '', selection: '', format: 'markdown', title: 'My Doc' };
  env.chrome.tabs.sendMessage = async (id, msg) => {
    if (msg.type === 'GET_SELECTION') return { ok: true, text: doc.selection };
    if (msg.type === 'GET_DOC_TEXT') return { ok: true, text: doc.text, format: doc.format, title: doc.title };
    if (msg.type === 'REPLACE_SELECTION') return { ok: true };
    return { ok: true, title: doc.title };
  };
  return { tab, doc };
}

// Records the JSON bodies of the provider requests; rounds[i] is the SSE text of the i-th request.
function recordFetch(env, rounds) {
  const bodies = [];
  env.ctx.fetch = async (url, init) => {
    const b = JSON.parse(init.body);
    bodies.push(b);
    return sseResponse(rounds[Math.min(bodies.length - 1, rounds.length - 1)]);
  };
  return bodies;
}

// Selects the provider (with an API key) for the next turns; Auto mode, no Google account.
function useProvider(env, prov, extra = {}) {
  const { state } = env;
  state.googleConnected = false; state.applyMode = 'auto'; state.settings.provider = prov;
  Object.assign(state.settings.providers[prov], { apiKey: prov === 'anthropic' ? 'sk-ant-T' : prov === 'openai' ? 'sk-T' : 'k-T', ...extra });
}

async function send(env, text) {
  env.T.el.input.value = text;
  await env.T.sendMessage();
}

// OpenAI Responses API rounds: one function call, or a text answer.
const oaTool = (callId, name, args) => {
  const item = { type: 'function_call', id: 'fc_' + callId, call_id: callId, name, arguments: JSON.stringify(args), status: 'completed' };
  return ev('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } }) +
    ev('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', output_index: 0, delta: item.arguments }) +
    ev('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }) +
    ev('response.completed', { type: 'response.completed', response: { status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } });
};
const oaText = (t) => ev('response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, delta: t }) +
  ev('response.completed', { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', id: 'msg_t', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: t }] }], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } });

// Munin (Chat Completions) rounds.
const cc = (o) => `data: ${JSON.stringify(o)}\n\n`;
const muTool = (id, name, args) => cc({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) +
  cc({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n';
const muText = (t) => cc({ choices: [{ index: 0, delta: { content: t } }] }) + cc({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n';

// A deep copy without any cache_control fields (the markers are not part of the cached content).
const stripCache = (v) => JSON.parse(JSON.stringify(v), (k, x) => (k === 'cache_control' ? undefined : x));
// The cache_control markers of an Anthropic body: where they are ('system:i' or 'messages:i:j').
function breakpoints(body) {
  const out = [];
  (body.system || []).forEach((b, i) => { if (b.cache_control) out.push(`system:${i}`); });
  (body.messages || []).forEach((m, i) => m.content.forEach((b, j) => { if (b.cache_control) out.push(`messages:${i}:${j}`); }));
  return out;
}

module.exports = { docBench, recordFetch, useProvider, send, oaTool, oaText, muTool, muText, stripCache, breakpoints };
