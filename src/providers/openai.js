'use strict';
// Module providers/openai.js: OpenAI Responses API: request builder (buildOpenAiRequest,
// toResponsesInput, openaiCacheKey) and stream parser (streamResponses).
/* global addNotice, apiUrl, bearerHeaders, fitMessages, joinSystem, lastUserIndex,
   offersWriteTools, openaiSearchRow, openaiSources, postJson, readStream, streamError, state, toOpenAiTool, userContent,
   webSearchTurn */
/* exported openaiReasoningModel, buildOpenAiRequest, streamResponses */

// ---------------------------------------------------------------------------
// OpenAI: Responses API (POST {base}/responses). Chat Completions is not used because the current
// GPT models only support tool calling (replace_selection, reading tools) through the Responses API.
// ---------------------------------------------------------------------------
// Reasoning models take the "reasoning" parameter; GPT-4-class models reject it.
const openaiReasoningModel = (model) => /^(gpt-[5-9]|o\d)/i.test(String(model || '').trim());

// Responses API input items from the history. For the rounds of the current turn the output items
// returned by the API (reasoning items with their encrypted content, messages, function calls) are
// replayed verbatim, as the API requires between a function call and its output with reasoning
// models; older turns are rebuilt from text and tool calls (their reasoning items are optional).
function toResponsesInput(hasTools, history) {
  const stripTools = !hasTools;
  const lastUser = lastUserIndex(history);
  const items = [];
  history.forEach((m, i) => {
    if (m.role === 'user') { items.push({ role: 'user', content: userContent(m, false) }); return; }
    if (m.role === 'tool') {
      if (!stripTools) items.push({ type: 'function_call_output', call_id: m.tool_call_id, output: m.content });
      return;
    }
    if (m.role !== 'assistant') return;
    if (i > lastUser && Array.isArray(m._openaiItems) && m._openaiItems.length) {
      for (const it of m._openaiItems) if (!(stripTools && it.type === 'function_call')) items.push(it);
      return;
    }
    const withCalls = !stripTools && Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
    const content = m.content || '';
    if (content.trim()) items.push({ role: 'assistant', content });
    if (withCalls) {
      for (const tc of m.tool_calls) {
        items.push({ type: 'function_call', call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments || '{}' });
      }
    }
  });
  return items;
}

// prompt_cache_key: routes the requests of one chat to the same prompt cache (document ID + chat ID;
// kept within 64 characters, its end, with the chat ID, is kept). null without a document or chat.
function openaiCacheKey(snap) {
  const chatId = snap.chatCtx ? snap.chatCtx.chatId : state.chatId;
  if (!snap.docId || !chatId) return null;
  const key = `${snap.docId}:${chatId}`;
  return key.length > 64 ? key.slice(key.length - 64) : key;
}

function buildOpenAiRequest(mode, snap, opts = {}) {
  const { cfg } = snap;
  const fit = fitMessages(mode, snap, opts);
  const body = {
    model: cfg.model,
    // Static (instructions and document instructions): the document summary and the selection travel in
    // the user messages (their _context), so the prefix stays the same across rounds and turns.
    instructions: joinSystem(fit.system),
    input: toResponsesInput(fit.tools.length > 0, fit.history),
    max_output_tokens: opts.maxTokens || snap.prov.maxTokens,
    stream: true,
    store: false, // stateless: the panel replays the history itself; reasoning items then carry encrypted_content
    include: ['reasoning.encrypted_content'],
  };
  const cacheKey = openaiCacheKey(snap);
  if (cacheKey) body.prompt_cache_key = cacheKey;
  if (fit.tools.length) body.tools = fit.tools.map(toOpenAiTool);
  if (offersWriteTools(fit.tools)) body.parallel_tool_calls = false; // edits one at a time (line numbers shift)
  if (webSearchTurn(mode, snap)) body.tools = [...(body.tools || []), { type: 'web_search' }]; // server-side search (/research)
  // The model's default reasoning effort is used (no reasoning.effort).
  if (openaiReasoningModel(cfg.model) && !state.openaiNoSummary) body.reasoning = { summary: 'auto' }; // feeds the Thinking section
  return { ...fit, kind: 'responses', url: apiUrl(snap, '/responses'), headers: bearerHeaders(cfg), body };
}

// ---------------------------------------------------------------------------
// OpenAI: Responses API stream. Events are JSON objects with a "type" field (the SSE "event:" line
// repeats it): response.output_item.added / .done carry whole output items (message, reasoning,
// function_call), the *.delta events carry text; response.completed / .incomplete / .failed end
// the stream with the final response object (canonical output items and usage).
// ---------------------------------------------------------------------------
async function streamResponses(req, signal, snap, hooks) {
  let content = '';
  let reasoning = '';
  const calls = []; // in order of the function_call items
  const callIndexByItem = new Map(); // output_index -> index in calls
  const searchRows = new Map(); // output_index -> activity row of a web_search_call (/research)
  let items = null; // final output items
  let status = null;
  let incomplete = null;
  let usage = null;
  const finishReason = () => {
    if (!status) return null;
    if (status === 'incomplete') return incomplete && incomplete.reason === 'max_output_tokens' ? 'length' : `incomplete: ${(incomplete && incomplete.reason) || 'unknown reason'}`;
    return calls.length ? 'tool_calls' : 'stop';
  };
  const partial = () => ({ content, reasoning, toolCalls: calls.filter(Boolean), finishReason: finishReason(), usage });
  const fail = (msg) => streamError(msg, partial);

  // Reasoning summaries need an organization that may use them; when the API refuses the request
  // because of the summary, it is retried without it (and no longer asked for in this session).
  let resp;
  try {
    resp = await postJson(req, signal, snap);
  } catch (e) {
    const r = req.body.reasoning;
    if (e.status === 400 && r && r.summary && /summar|verif/i.test(e.serverMessage || e.message)) {
      state.openaiNoSummary = true;
      const body = { ...req.body, reasoning: { ...r } };
      delete body.reasoning.summary;
      if (!Object.keys(body.reasoning).length) delete body.reasoning;
      resp = await postJson({ ...req, body }, signal, snap);
      addNotice('Reasoning summaries are not available for this OpenAI account or model; the Thinking section stays empty.', { sticky: true });
    } else {
      throw e;
    }
  }

  const slotFor = (outputIndex) => {
    if (!callIndexByItem.has(outputIndex)) {
      callIndexByItem.set(outputIndex, calls.length);
      calls.push({ id: '', type: 'function', function: { name: '', arguments: '' } });
    }
    return calls[callIndexByItem.get(outputIndex)];
  };
  const setCall = (outputIndex, item) => {
    const slot = slotFor(outputIndex);
    if (item.call_id) slot.id = item.call_id;
    if (item.name) slot.function.name = item.name;
    if (typeof item.arguments === 'string' && item.arguments) slot.function.arguments = item.arguments;
    hooks.onToolCall && hooks.onToolCall(callIndexByItem.get(outputIndex), slot);
  };
  const finish = (response) => {
    status = response.status || 'completed';
    incomplete = response.incomplete_details || null;
    if (Array.isArray(response.output)) items = response.output;
    const u = response.usage;
    if (u) {
      const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
      usage = { prompt_tokens: n(u.input_tokens), completion_tokens: n(u.output_tokens) };
      usage.total_tokens = n(u.total_tokens) || usage.prompt_tokens + usage.completion_tokens;
      if (u.input_tokens_details && n(u.input_tokens_details.cached_tokens)) usage.cache_read_input_tokens = n(u.input_tokens_details.cached_tokens);
      if (u.output_tokens_details && n(u.output_tokens_details.reasoning_tokens)) usage.reasoning_tokens = n(u.output_tokens_details.reasoning_tokens);
    }
  };
  const handle = (ev) => {
    switch (ev.type) {
      case 'response.output_text.delta':
      case 'response.refusal.delta':
        if (typeof ev.delta === 'string' && ev.delta) { content += ev.delta; hooks.onContent && hooks.onContent(content); }
        break;
      case 'response.reasoning_summary_part.added':
        if (reasoning && !reasoning.endsWith('\n\n')) reasoning += '\n\n'; // paragraph per summary part
        break;
      case 'response.reasoning_summary_text.delta':
        if (typeof ev.delta === 'string' && ev.delta) { reasoning += ev.delta; hooks.onReasoning && hooks.onReasoning(reasoning); }
        break;
      case 'response.output_item.added':
      case 'response.output_item.done':
        if (ev.item && ev.item.type === 'function_call') setCall(ev.output_index, ev.item);
        else if (ev.item && ev.item.type === 'web_search_call') {
          searchRows.set(ev.output_index, openaiSearchRow(ev.item));
          hooks.onActivity && hooks.onActivity([...searchRows.values()]);
        }
        break;
      case 'response.function_call_arguments.delta': {
        const slot = slotFor(ev.output_index);
        if (typeof ev.delta === 'string') slot.function.arguments += ev.delta;
        break;
      }
      case 'response.function_call_arguments.done': {
        const slot = slotFor(ev.output_index);
        if (typeof ev.arguments === 'string') slot.function.arguments = ev.arguments;
        break;
      }
      case 'response.completed':
      case 'response.incomplete':
        finish(ev.response || {});
        break;
      case 'response.failed': {
        finish(ev.response || {});
        const er = (ev.response && ev.response.error) || {};
        throw fail('API error (stream): ' + (er.message || er.code || 'the response failed'));
      }
      case 'error':
        throw fail('API error (stream): ' + (ev.message || (ev.error && ev.error.message) || ev.code || JSON.stringify(ev)));
      default: // response.created, response.in_progress, content_part events, *.done text events, ...
        break;
    }
  };

  await readStream(resp, (event, data) => {
      if (!data || typeof data !== 'object') return;
      if (!data.type && event) data.type = event;
      handle(data);
    }, partial);
  if (!status) throw fail('The response stream was cut off');

  // The final response object is canonical: tool calls (and text, if nothing was streamed) are
  // taken from its output items; the items themselves are replayed in the next round of this turn.
  if (items) {
    const fcs = items.filter((it) => it && it.type === 'function_call');
    if (fcs.length) {
      calls.length = 0;
      for (const it of fcs) {
        calls.push({
          id: it.call_id || '', type: 'function',
          function: { name: it.name || '', arguments: typeof it.arguments === 'string' ? it.arguments : JSON.stringify(it.arguments || {}) },
        });
      }
    }
    if (!content) {
      content = items.filter((it) => it && it.type === 'message' && Array.isArray(it.content))
        .flatMap((it) => it.content).filter((c) => c && (c.type === 'output_text' || c.type === 'refusal'))
        .map((c) => c.text || c.refusal || '').join('');
    }
  }
  calls.forEach((c, i) => { if (c && !c.id) c.id = `call_${Date.now()}_${i}`; });
  const replay = (items || []).filter((it) => it && ['reasoning', 'message', 'function_call', 'web_search_call'].includes(it.type));
  // Web search (/research): rows of the search calls and the url_citation sources of the answer.
  const activity = items ? items.filter((it) => it && it.type === 'web_search_call').map(openaiSearchRow) : [...searchRows.values()];
  return { ...partial(), raw: { key: '_openaiItems', items: replay }, activity, sources: openaiSources(items || []) };
}
