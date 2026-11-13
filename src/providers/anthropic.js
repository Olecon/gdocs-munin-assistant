'use strict';
// Module providers/anthropic.js: Anthropic Messages API: request builder (buildAnthropicRequest,
// toAnthropicMessages, addCacheBreakpoint, keepThinkingValid, anthropicHeaders), the model lines read from the id
// (anthropicAdaptive, anthropicForcedToolOk, anthropicChecksHistory), programmatic tool calling (anthropicRunsCode, the
// basic search after a refusal: anthropicSearchRefused), no strict tools after a refusal (anthropicStrictRefused) and
// stream parser (streamAnthropic).
/* global ANTHROPIC_FALLBACK_BETA, ANTHROPIC_FALLBACK_MODELS, ANTHROPIC_VERSION, anthropicActivity,
   anthropicSources, anthropicWebSearchTool, apiUrl, fitMessages, lastUserIndex, offersWriteTools,
   parseToolArgs, postJson, previousUserIndex, readStream, samplingFields, streamError, toAnthropicTool, userContent, webSearchTurn */
/* exported anthropicAdaptive, anthropicChecksHistory, anthropicForcedToolOk, anthropicRunsCode, anthropicBasicSearch,
   anthropicSearchRefused, anthropicStrictRefused, buildAnthropicRequest, anthropicHeaders, streamAnthropic */

// ---------------------------------------------------------------------------
// Anthropic: Messages API (POST {base}/messages)
// ---------------------------------------------------------------------------
// The line and version of a Claude model id ({ family, major, minor }), or null for another id.
function claudeVersion(model) {
  const m = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?/i.exec(String(model || '').trim());
  if (!m) return null;
  // A long second number is a date (claude-sonnet-4-20250514, claude-haiku-4-5-20251001 keeps its 5).
  return { family: m[1].toLowerCase(), major: Number(m[2]), minor: m[3] && m[3].length <= 2 ? Number(m[3]) : 0 };
}
const versionAtLeast = (v, major, minor) => v.major > major || (v.major === major && v.minor >= minor);
// Claude 4.6 and later (and the Fable / Mythos line) take adaptive thinking;
// older models (Haiku 4.5, Sonnet 4.5, Opus 4.1, Claude 3.x, dated snapshots) are sent without them.
function anthropicAdaptive(model) {
  const v = claudeVersion(model);
  return !!v && versionAtLeast(v, 4, 6);
}
// The first version of each line with the rules Claude Fable 5.1 brought: a forced tool choice ({type: "any"} or "tool")
// is a 400, and a replayed thinking block is checked against everything sent before it (the history-editing check).
// Claude Haiku 5.5 runs the check but accepts a forced tool choice. A later major version is taken to keep both rules.
const STRICT_LINE = { fable: [5, 1], mythos: [5, 1], opus: [5, 5], sonnet: [5, 5], haiku: [5, 5] };
const strictLine = (v) => !!v && (v.major > 5 || versionAtLeast(v, ...STRICT_LINE[v.family]));
const anthropicChecksHistory = (model) => strictLine(claudeVersion(model));
function anthropicForcedToolOk(model) {
  const v = claudeVersion(model);
  return !strictLine(v) || (v.family === 'haiku' && v.major === 5);
}

// A server tool that runs code execution under the hood: the code execution tool, web search or web fetch with dynamic
// filtering (the 20260209 versions and later) unless it is called directly. With one in the request the API counts it as
// programmatic tool calling, which refuses disable_parallel_tool_use and a forced tool choice.
function runsCode(t) {
  const m = /^(web_search|web_fetch|code_execution)_(\d{8})$/.exec((t && t.type) || '');
  if (!m || (Array.isArray(t.allowed_callers) && t.allowed_callers.join() === 'direct')) return false;
  return m[1] === 'code_execution' || Number(m[2]) >= 20260209;
}
const anthropicRunsCode = (body) => !!body && Array.isArray(body.tools) && body.tools.some(runsCode);

// The accounts' models whose request with the filtering search came back as a 400 that names programmatic tool calling:
// their requests carry the basic search (ANTHROPIC_BASIC_SEARCH) for the rest of the session. Not stored: a later
// session tries the filtering search again.
const basicSearchModels = new Set();
const basicSearchKey = (cfg) => `${(cfg && cfg.accountId) || ''}\n${(cfg && cfg.model) || ''}`;
const anthropicBasicSearch = (cfg) => basicSearchModels.has(basicSearchKey(cfg));
// Whether error e of request req is that refusal (toolLoop then builds the request again, once): it is remembered for
// the account's model. A request without a tool that runs code, or a model already on the basic search, is no such case.
function anthropicSearchRefused(e, req, snap) {
  if (!e || e.status !== 400 || !req || req.kind !== 'anthropic' || !anthropicRunsCode(req.body)) return false;
  if (!/programmatic tool calling/i.test(String(e.serverMessage || e.message || ''))) return false;
  const key = basicSearchKey(snap && snap.cfg);
  if (basicSearchModels.has(key)) return false;
  basicSearchModels.add(key);
  return true;
}

// The accounts' models whose request with strict tools came back as a 400 about strict tools or the schemas (too many, too
// complex for compilation, a schema feature, structured outputs not available, strict next to programmatic tool calling):
// their requests carry no strict tool for the rest of the session, every schema compact. Not stored, as above.
const looseToolModels = new Set();
const anthropicLooseTools = (cfg) => looseToolModels.has(basicSearchKey(cfg));
const STRICT_REFUSAL_RE = /\bstrict\b|structured outputs?|schema|grammar/i;
const sendsStrict = (body) => !!body && Array.isArray(body.tools) && body.tools.some((t) => t && t.strict === true);
// Whether error e of request req is that refusal (toolLoop then builds the request again, once): it is remembered for the
// account's model. A request without a strict tool is no such case.
function anthropicStrictRefused(e, req, snap) {
  if (!e || e.status !== 400 || !req || req.kind !== 'anthropic' || !sendsStrict(req.body)) return false;
  if (!STRICT_REFUSAL_RE.test(String(e.serverMessage || e.message || ''))) return false;
  const key = basicSearchKey(snap && snap.cfg);
  if (looseToolModels.has(key)) return false;
  looseToolModels.add(key);
  return true;
}

// Messages API messages from the history. Consecutive same-role messages are merged (tool results
// and the next user text share one user message) and the conversation starts with a user message.
// For the rounds of the current turn the content blocks returned by the API (thinking with its
// signature, text, tool_use) are replayed verbatim: a tool_use turn must go back with its thinking,
// and the blocks are bound to the unchanged request prefix. Older turns are rebuilt from text and
// tool calls, without thinking (thinking blocks may be removed from the front of the history).
// A user message is sent with its turn context (userContent). cacheAt: the history index of a user
// message whose text block gets a cache breakpoint (the start of the previous turn, see buildAnthropicRequest).
// dropThinking: the assistant messages (a WeakSet) whose replay goes without its thinking blocks (keepThinkingValid).
function toAnthropicMessages(hasTools, history, { cacheAt = -1, dropThinking = null } = {}) {
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
      const noThinking = !!dropThinking && dropThinking.has(m);
      push('assistant', m._anthropicBlocks.filter((b) => !(stripTools && b.type === 'tool_use') && !(noThinking && isThinkingBlock(b))));
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

const isThinkingBlock = (b) => !!b && (b.type === 'thinking' || b.type === 'redacted_thinking');
// The messages of a request with their cache breakpoints (see buildAnthropicRequest).
function anthropicMessages(fit, dropThinking) {
  const messages = toAnthropicMessages(fit.tools.length > 0, fit.history, { cacheAt: previousUserIndex(fit.history), dropThinking });
  addCacheBreakpoint(messages);
  return messages;
}
// What a request sends, block by block, without its cache breakpoints (moving one is no edit): the system prompt and the
// tools first, then every message block with its role.
function sentSequence(body) {
  const plain = (x) => JSON.stringify(x, (k, v) => (k === 'cache_control' ? undefined : v));
  return [plain([body.system || [], body.tools || []]), ...body.messages.flatMap((m) => m.content.map((b) => `${m.role}:${plain(b)}`))];
}
// The history-editing check of the newer models (anthropicChecksHistory): a thinking block is valid only while the system
// prompt, the tools and everything sent before it are unchanged. The rounds of a turn are appended, but some requests
// change what came before: the turn's older reading results stubbed to fit the window (or after the server found the
// request too long), older turns trimmed, the document in the prompt cut, the search tool or the strict tools changed after a refusal. Such a
// request (not an append of the turn's previous one, snap.anthropicSent) goes without the thinking blocks of the turn's
// rounds so far, and they stay out for the rest of the turn (snap.thinkingDropped): removing all of them keeps the
// request valid, putting one back would not. The blocks of the later rounds are replayed as usual.
function keepThinkingValid(fit, body, snap) {
  const dropped = snap.thinkingDropped || (snap.thinkingDropped = new WeakSet());
  let seq = sentSequence(body);
  const prev = snap.anthropicSent;
  if (prev && !(seq.length >= prev.length && prev.every((s, i) => s === seq[i]))) {
    const lastUser = lastUserIndex(fit.history);
    let more = false;
    fit.history.forEach((m, i) => {
      if (i <= lastUser || m.role !== 'assistant' || dropped.has(m) || !Array.isArray(m._anthropicBlocks) || !m._anthropicBlocks.some(isThinkingBlock)) return;
      dropped.add(m);
      more = true;
    });
    if (more) { body.messages = anthropicMessages(fit, dropped); seq = sentSequence(body); }
  }
  snap.anthropicSent = seq;
}

function buildAnthropicRequest(mode, snap, opts = {}) {
  const { cfg } = snap;
  const fit = fitMessages(mode, snap, opts);
  const checked = anthropicChecksHistory(cfg.model);
  const messages = anthropicMessages(fit, checked ? snap.thinkingDropped : null);
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
  // A temperature only when the user set one for the model (settings.js providerFor leaves it out for the models with
  // adaptive thinking, which refuse it).
  const { temperature } = samplingFields(snap.prov);
  if (temperature !== undefined) body.temperature = temperature;
  // A fixed set of tools strict (request.js ANTHROPIC_STRICT_TOOLS), none after a refusal (anthropicStrictRefused).
  const loose = anthropicLooseTools(cfg);
  if (fit.tools.length) body.tools = fit.tools.map((t) => toAnthropicTool(t, loose));
  // Server-side search (webSearchTurn), only next to the client tools (not in the probe or the wrap-up round). The
  // filtering search unless the API refused it for this account's model in this session (anthropicSearchRefused).
  if (fit.tools.length && webSearchTurn(mode, snap)) body.tools = [...body.tools, anthropicWebSearchTool(cfg.model, anthropicBasicSearch(cfg))];
  // Edits one at a time (line numbers shift). Not next to the filtering search: it runs code execution, and the API
  // refuses disable_parallel_tool_use with programmatic tool calling; the turn loop then runs only the first writing
  // call of a response (runRoundCalls) and answers the others.
  if (offersWriteTools(fit.tools) && !anthropicRunsCode(body)) body.tool_choice = { type: 'auto', disable_parallel_tool_use: true };
  if (checked) keepThinkingValid(fit, body, snap);
  const headers = anthropicHeaders(cfg);
  // The model's default effort is used (no output_config.effort).
  // The summary feeds the Thinking section. Not when a tool call of this turn has no thinking to go back with (the chat's
  // model was switched from another provider inside the tool loop: models, src/accounts.js).
  if (anthropicAdaptive(cfg.model) && !(fit.tools.length && foreignToolRound(fit.history))) body.thinking = { type: 'adaptive', display: 'summarized' };
  // Server-side fallback on a safety refusal: the API re-runs the request on another Claude model
  // (the panel reports the model that answered).
  const url = apiUrl(snap, '/messages');
  if (ANTHROPIC_FALLBACK_MODELS.has(cfg.model)) {
    body.fallbacks = 'default';
    headers['anthropic-beta'] = ANTHROPIC_FALLBACK_BETA;
  }
  return { ...fit, kind: 'anthropic', url, headers, body };
}
// A round of the current turn with tool calls but without Anthropic's blocks (it came from another provider).
function foreignToolRound(history) {
  const lastUser = lastUserIndex(history);
  return history.some((m, i) => i > lastUser && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0 &&
    !(Array.isArray(m._anthropicBlocks) && m._anthropicBlocks.length));
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

// The index of the last "fallback" block of a response, or -1.
const lastFallback = (blocks) => blocks.reduce((at, b, i) => (b && b.type === 'fallback' ? i : at), -1);
// The blocks of a response as they go back to the API (in order, without holes). Before the last fallback block the
// API's rule for echoing a fallback turn leaves out the declined model's thinking, its tool calls and its server tool
// calls without a result; its text and everything from the fallback block on go back as they came.
function fallbackEcho(blocks, cut) {
  const answered = new Set(blocks.filter((b) => b && b.tool_use_id).map((b) => b.tool_use_id));
  return blocks.filter((b, i) => !!b && (i >= cut || !(isThinkingBlock(b) || b.type === 'tool_use' ||
    (b.type === 'server_tool_use' && !answered.has(b.id)))));
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
    const called = calls.some(Boolean);
    if (stopReason === 'tool_use') return 'tool_calls';
    if (stopReason === 'max_tokens') return 'length';
    if (stopReason === 'refusal') return 'refusal';
    if (stopReason === 'pause_turn') return called ? 'tool_calls' : 'pause_turn'; // a long server-side search: send it back
    if (stopReason === 'end_turn' || stopReason === 'stop_sequence') return called ? 'tool_calls' : 'stop';
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
  // A server-side fallback in the middle of the output (a "fallback" block): the declined model's tool calls before the
  // last such block are not run (a refusal can cut a call off mid-input).
  const cut = lastFallback(blocks);
  for (const [bi, ci] of callIndexByBlock) if (bi < cut) calls[ci] = null;
  calls.forEach((c, i) => { if (c && !c.id) c.id = `toolu_${Date.now()}_${i}`; });
  // Blocks to replay in the next round of this turn, exactly as returned (minus the accumulator).
  const replay = fallbackEcho(blocks, cut).map(({ _json, ...b }) => b).filter((b) => !(b.type === 'text' && !b.text));
  return { ...partial(), raw: { key: '_anthropicBlocks', items: replay }, activity: anthropicActivity(blocks), sources: anthropicSources(blocks) };
}
