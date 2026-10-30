'use strict';
// Module providers/anthropic.js: Anthropic Messages API: request builder (buildAnthropicRequest,
// toAnthropicMessages, addCacheBreakpoint, anthropicAdaptive, anthropicHeaders) and stream parser (streamAnthropic).
/* global ANTHROPIC_FALLBACK_BETA, ANTHROPIC_FALLBACK_MODELS, ANTHROPIC_VERSION, anthropicActivity,
   anthropicSources, anthropicWebSearchTool, apiUrl, fitMessages, lastUserIndex, offersWriteTools,
   parseToolArgs, postJson, previousUserIndex, readStream, streamError, toAnthropicTool, userContent, webSearchTurn */
/* exported anthropicAdaptive, buildAnthropicRequest, anthropicHeaders, streamAnthropic */

// ---------------------------------------------------------------------------
// Anthropic: Messages API (POST {base}/messages)
// ---------------------------------------------------------------------------
// Claude 4.6 and later (and the Fable / Mythos line) take adaptive thinking;
// older models (Haiku 4.5, Sonnet 4.5, Opus 4.1, Claude 3.x, dated snapshots) are sent without them.
function anthropicAdaptive(model) {
  const m = /^claude-(?:opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?/i.exec(String(model || '').trim());
  if (!m) return false;
  const major = Number(m[1]);
  const minor = m[2] && m[2].length <= 2 ? Number(m[2]) : 0; // a long second number is a date (claude-sonnet-4-20250514)
  return major >= 5 || (major === 4 && minor >= 6);
}

// Messages API messages from the history. Consecutive same-role messages are merged (tool results
// and the next user text share one user message) and the conversation starts with a user message.
// For the rounds of the current turn the content blocks returned by the API (thinking with its
// signature, text, tool_use) are replayed verbatim: a tool_use turn must go back with its thinking,
// and the blocks are bound to the unchanged request prefix. Older turns are rebuilt from text and
// tool calls, without thinking (thinking blocks may be removed from the front of the history).
// A user message is sent with its turn context (userContent). cacheAt: the history index of a user
// message whose text block gets a cache breakpoint (the start of the previous turn, see buildAnthropicRequest).
function toAnthropicMessages(hasTools, history, { cacheAt = -1 } = {}) {
  const stripTools = !hasTools;
  const lastUser = lastUserIndex(history);
  const msgs = [];
  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = msgs[msgs.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else msgs.push({ role, content: blocks });
  };
  history.forEach((m, i) => {
    if (m.role === 'user') {
      if (!m.content.trim()) return;
      const block = { type: 'text', text: userContent(m, false) };
      if (i === cacheAt) block.cache_control = { type: 'ephemeral' };
      push('user', [block]);
      return;
    }
    if (m.role === 'tool') {
      if (stripTools) return;
      const block = { type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content };
      if (m._ok === false) block.is_error = true;
      push('user', [block]);
      return;
    }
    if (m.role !== 'assistant') return;
    if (i > lastUser && Array.isArray(m._anthropicBlocks) && m._anthropicBlocks.length) {
      push('assistant', m._anthropicBlocks.filter((b) => !(stripTools && b.type === 'tool_use')));
      return;
    }
    const blocks = [];
    const content = m.content || '';
    if (content.trim()) blocks.push({ type: 'text', text: content });
    if (!stripTools && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: parseToolArgs(tc).args });
    }
    push('assistant', blocks);
  });
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  return msgs;
}

// Block types that may carry cache_control here (thinking blocks may not; server tool blocks are skipped).
const CACHEABLE_BLOCKS = ['text', 'tool_use', 'tool_result'];
// Puts a cache breakpoint on the last block of the last message (a copy of the block: the stored replay
// blocks are not changed). Skipped when that block cannot carry one or already has one.
function addCacheBreakpoint(msgs) {
  const last = msgs[msgs.length - 1];
  if (!last || !last.content.length) return;
  const i = last.content.length - 1;
  const b = last.content[i];
  if (!CACHEABLE_BLOCKS.includes(b.type) || b.cache_control) return;
  last.content[i] = { ...b, cache_control: { type: 'ephemeral' } };
}

function buildAnthropicRequest(mode, snap, opts = {}) {
  const { cfg } = snap;
  const fit = fitMessages(mode, snap, opts);
  const messages = toAnthropicMessages(fit.tools.length > 0, fit.history, { cacheAt: previousUserIndex(fit.history) });
  addCacheBreakpoint(messages);
  const body = {
    model: cfg.model,
    max_tokens: opts.maxTokens || snap.prov.maxTokens,
    // Prompt caching, at most 3 of the 4 allowed breakpoints: (1) the static system prompt (tools and
    // instructions repeat on every round and turn of a chat); (2) the last block of the conversation, so
    // the next round of this turn reads the history so far from the cache; (3) the user message that
    // started the previous turn (written as (2) in that turn's first round): the history up to there is
    // sent unchanged in later turns, while the previous turn's rounds are rebuilt without thinking.
    // The document summary and the selection travel in the user messages (their _context).
    system: [{ type: 'text', text: fit.system.head, cache_control: { type: 'ephemeral' } }],
    messages,
    stream: true,
  };
  if (fit.tools.length) body.tools = fit.tools.map(toAnthropicTool);
  if (offersWriteTools(fit.tools)) body.tool_choice = { type: 'auto', disable_parallel_tool_use: true }; // edits one at a time
  if (webSearchTurn(mode, snap)) body.tools = [...(body.tools || []), anthropicWebSearchTool(cfg.model)]; // server-side search (/research)
  const headers = anthropicHeaders(cfg);
  // The model's default effort is used (no output_config.effort).
  if (anthropicAdaptive(cfg.model)) body.thinking = { type: 'adaptive', display: 'summarized' }; // the summary feeds the Thinking section
  // Server-side fallback on a safety refusal: the API re-runs the request on another Claude model
  // (the panel reports the model that answered).
  const url = apiUrl(snap, '/messages');
  if (ANTHROPIC_FALLBACK_MODELS.has(cfg.model)) {
    body.fallbacks = 'default';
    headers['anthropic-beta'] = ANTHROPIC_FALLBACK_BETA;
  }
  return { ...fit, kind: 'anthropic', url, headers, body };
}
const anthropicHeaders = (cfg) => ({
  'Content-Type': 'application/json',
  'x-api-key': cfg.apiKey,
  'anthropic-version': ANTHROPIC_VERSION,
  'anthropic-dangerous-direct-browser-access': 'true', // the request is sent from the extension page
});

// ---------------------------------------------------------------------------
// Anthropic: Messages API stream: message_start (model, input usage) -> per content block
// content_block_start / content_block_delta (text_delta, thinking_delta, signature_delta,
// input_json_delta) / content_block_stop -> message_delta (stop_reason, output usage) -> message_stop.
// ---------------------------------------------------------------------------
function anthropicUsage(u, prev) {
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const out = { ...(prev || {}) };
  const input = n(u.input_tokens);
  const cacheRead = n(u.cache_read_input_tokens);
  const cacheCreate = n(u.cache_creation_input_tokens);
  const output = n(u.output_tokens);
  if (input != null) out.input_tokens = input;
  if (cacheRead != null) out.cache_read_input_tokens = cacheRead;
  if (cacheCreate != null) out.cache_creation_input_tokens = cacheCreate;
  if (output != null) out.completion_tokens = output;
  if (u.server_tool_use && n(u.server_tool_use.web_search_requests)) out.web_search_requests = n(u.server_tool_use.web_search_requests);
  out.prompt_tokens = (out.input_tokens || 0) + (out.cache_read_input_tokens || 0) + (out.cache_creation_input_tokens || 0);
  out.total_tokens = out.prompt_tokens + (out.completion_tokens || 0);
  return out;
}

async function streamAnthropic(req, signal, snap, hooks) {
  const blocks = []; // content blocks by index, as returned (plus a _json accumulator for tool_use)
  let content = '';
  let reasoning = '';
  const calls = [];
  const callIndexByBlock = new Map(); // block index -> index in calls
  let stopReason = null;
  let stopDetails = null;
  let usage = null;
  let servedBy = null;
  let sawStop = false;
  const finishReason = () => {
    if (stopReason === 'tool_use') return 'tool_calls';
    if (stopReason === 'max_tokens') return 'length';
    if (stopReason === 'refusal') return 'refusal';
    if (stopReason === 'pause_turn') return calls.length ? 'tool_calls' : 'pause_turn'; // a long server-side search: send it back
    if (stopReason === 'end_turn' || stopReason === 'stop_sequence') return calls.length ? 'tool_calls' : 'stop';
    return stopReason;
  };
  const partial = () => ({ content, reasoning, toolCalls: calls.filter(Boolean), finishReason: finishReason(), usage, servedBy, stopDetails });
  const fail = (msg) => streamError(msg, partial);

  const resp = await postJson(req, signal, snap);

  const refreshText = () => {
    content = blocks.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('');
    reasoning = blocks.filter((b) => b && b.type === 'thinking').map((b) => b.thinking || '').filter(Boolean).join('\n\n');
  };
  const handle = (ev) => {
    switch (ev.type) {
      case 'message_start': {
        const msg = ev.message || {};
        if (msg.model) servedBy = msg.model;
        if (msg.usage) usage = anthropicUsage(msg.usage, usage);
        break;
      }
      case 'content_block_start': {
        const b = { ...(ev.content_block || {}) };
        if (b.type === 'text' && typeof b.text !== 'string') b.text = '';
        if (b.type === 'thinking' && typeof b.thinking !== 'string') b.thinking = '';
        if (b.type === 'server_tool_use') { b._json = ''; if (!b.input || typeof b.input !== 'object') b.input = {}; }
        if (b.type === 'tool_use') {
          b._json = '';
          if (!b.input || typeof b.input !== 'object') b.input = {};
          const idx = calls.length;
          callIndexByBlock.set(ev.index, idx);
          calls.push({ id: b.id || '', type: 'function', function: { name: b.name || '', arguments: '' } });
          hooks.onToolCall && hooks.onToolCall(idx, calls[idx]);
        }
        blocks[ev.index] = b;
        if (b.type === 'web_search_tool_result' || b.type === 'web_fetch_tool_result') hooks.onActivity && hooks.onActivity(anthropicActivity(blocks));
        break;
      }
      case 'content_block_delta': {
        const b = blocks[ev.index];
        const d = ev.delta || {};
        if (!b) break;
        if (d.type === 'text_delta' && typeof d.text === 'string') {
          b.text = (b.text || '') + d.text; refreshText(); hooks.onContent && hooks.onContent(content);
        } else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
          b.thinking = (b.thinking || '') + d.thinking; refreshText(); hooks.onReasoning && hooks.onReasoning(reasoning);
        } else if (d.type === 'signature_delta' && typeof d.signature === 'string') {
          b.signature = (b.signature || '') + d.signature;
        } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
          b._json = (b._json || '') + d.partial_json;
          const slot = calls[callIndexByBlock.get(ev.index)];
          if (slot) slot.function.arguments = b._json;
        } else if (d.type === 'citations_delta' && d.citation) {
          (b.citations || (b.citations = [])).push(d.citation); // web search citations, replayed with the block
        }
        break;
      }
      case 'content_block_stop': {
        const b = blocks[ev.index];
        if (b && b.type === 'tool_use') {
          try { b.input = b._json ? JSON.parse(b._json) : (b.input || {}); } catch (e) { b.input = {}; }
          const slot = calls[callIndexByBlock.get(ev.index)];
          if (slot && !slot.function.arguments) slot.function.arguments = JSON.stringify(b.input);
        } else if (b && b._json !== undefined) {
          // A server tool call (server_tool_use: web_search, or code execution of dynamic filtering).
          try { b.input = b._json ? JSON.parse(b._json) : (b.input || {}); } catch (e) { b.input = b.input || {}; }
          if (b.type === 'server_tool_use') hooks.onActivity && hooks.onActivity(anthropicActivity(blocks));
        }
        break;
      }
      case 'message_delta': {
        const d = ev.delta || {};
        if (d.stop_reason) stopReason = d.stop_reason;
        if (d.stop_details) stopDetails = d.stop_details;
        if (ev.usage) usage = anthropicUsage(ev.usage, usage);
        break;
      }
      case 'message_stop':
        sawStop = true;
        break;
      case 'error': {
        const er = ev.error || {};
        throw fail(`API error (stream): ${er.message || er.type || JSON.stringify(ev)}`);
      }
      default: // ping
        break;
    }
  };

  await readStream(resp, (event, data) => {
      if (!data || typeof data !== 'object') return;
      if (!data.type && event) data.type = event;
      handle(data);
    }, partial);
  if (!sawStop && !stopReason) throw fail('The response stream was cut off');
  calls.forEach((c, i) => { if (c && !c.id) c.id = `toolu_${Date.now()}_${i}`; });
  // Blocks to replay in the next round of this turn, exactly as returned (minus the accumulator).
  const replay = blocks.filter(Boolean).map(({ _json, ...b }) => b).filter((b) => !(b.type === 'text' && !b.text));
  return { ...partial(), raw: { key: '_anthropicBlocks', items: replay }, activity: anthropicActivity(blocks), sources: anthropicSources(blocks) };
}
