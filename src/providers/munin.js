'use strict';
// Module providers/munin.js: Munin streams: OpenAI-compatible Chat Completions in raw mode
// (streamChat) and the persona stream of /research, /code, /chat (streamPersona).
/* global activitySummary, postJson, readStream, streamError */
/* exported streamChat, streamPersona */

// ---------------------------------------------------------------------------
// Munin: OpenAI-compatible Chat Completions stream (raw mode)
// ---------------------------------------------------------------------------
async function streamChat(req, signal, snap, hooks) {
  let content = '';
  let reasoning = '';
  const calls = [];
  let finishReason = null;
  let usage = null;
  let sawDone = false;
  const partial = () => ({ content, reasoning, toolCalls: calls.filter(Boolean), finishReason, usage });
  const fail = (msg) => streamError(msg, partial);

  const resp = await postJson(req, signal, snap);

  const handle = (chunk) => {
    if (chunk.error) {
      const m = typeof chunk.error === 'string' ? chunk.error : (chunk.error.message || JSON.stringify(chunk.error));
      throw fail('API error (stream): ' + m);
    }
    if (chunk.usage) usage = chunk.usage;
    const choice = Array.isArray(chunk.choices) && chunk.choices.length ? chunk.choices[0] : null;
    if (!choice) return; // e.g. the final usage-only chunk
    const d = choice.delta || {};
    const r = d.reasoning != null ? d.reasoning : d.reasoning_content;
    if (typeof r === 'string' && r) { reasoning += r; hooks.onReasoning && hooks.onReasoning(reasoning); }
    if (typeof d.content === 'string' && d.content) { content += d.content; hooks.onContent && hooks.onContent(content); }
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const idx = Number.isInteger(tc.index) ? tc.index : 0;
        const slot = calls[idx] || (calls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } });
        if (tc.id) slot.id = tc.id;
        if (tc.function) {
          if (tc.function.name) slot.function.name = tc.function.name; // later chunks carry name: null
          if (typeof tc.function.arguments === 'string') slot.function.arguments += tc.function.arguments;
        }
        hooks.onToolCall && hooks.onToolCall(idx, slot);
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  };

  await readStream(resp, (event, data) => {
      if (data === '[DONE]') { sawDone = true; return; }
      if (data && typeof data === 'object') handle(data);
    }, partial);
  if (!sawDone && !finishReason) throw fail('The response stream was cut off');
  calls.forEach((c, i) => { if (c && !c.id) c.id = `call_${Date.now()}_${i}`; });
  return partial();
}

// ---------------------------------------------------------------------------
// Munin: persona turns (/research, /code, /chat) with Munin's own SSE format. The request has no system
// message (Munin's ephemeral path would drop it): our instructions open the newest user message (personaMessages).
// The stream:
//   id: <stream-id>-<n>
//   event: <routing|conversation|thinking|token|tool_call|done|error>
//   data: {json}
// hooks: onReasoning(text), onContent(text), onActivity(list).
// Returns { content, reasoning, activity, usage, finishReason }. On abort/error throws with .partial.
// ---------------------------------------------------------------------------
async function streamPersona(req, signal, snap, hooks) {
  let content = '';
  let reasoning = '';
  const activity = [];
  let usage = null;
  let finishReason = null;
  let sawDone = false;
  const partial = () => ({ content, reasoning, activity: activity.slice(), usage, finishReason });
  const fail = (msg) => streamError(msg, partial);

  const resp = await postJson(req, signal, snap);

  const handle = (event, data) => {
    switch (event) {
      case 'thinking':
        if (data && typeof data.content === 'string' && data.content) {
          reasoning += data.content; hooks.onReasoning && hooks.onReasoning(reasoning);
        }
        break;
      case 'token':
        if (data && typeof data.content === 'string' && data.content) {
          content += data.content; hooks.onContent && hooks.onContent(content);
        }
        break;
      case 'tool_call':
        // Executed by the server; we only show an activity line.
        activity.push({ name: String((data && data.name) || 'tool'), summary: activitySummary(data && data.arguments) });
        hooks.onActivity && hooks.onActivity(activity);
        break;
      case 'done':
        sawDone = true;
        if (data && data.usage) usage = data.usage;
        finishReason = (data && (data.finish_reason || data.terminal_reason)) || 'stop';
        break;
      case 'error': {
        const m = data && (typeof data.error === 'string' ? data.error
          : (data.error && data.error.message) || data.message) || JSON.stringify(data);
        throw fail('API error (persona stream): ' + m);
      }
      default: // routing, conversation and unknown events
        break;
    }
  };

  await readStream(resp, (event, data) => { if (data && typeof data === 'object') handle(event, data); }, partial);
  if (!sawDone) throw fail('The persona response stream was cut off');
  return partial();
}
