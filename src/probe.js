'use strict';
// Module probe.js: the chat probe (probeChat). A provider's GET /models proves only that the key is known: a server
// may list its models for an account it no longer serves (Munin answers /models for a switched-off account). An explicit
// check (settings.js runModelCheck with probe: the key, the URL or the headers changed, Check provider; the models tool's
// check and switch) therefore also sends one tiny chat request: "ping" with a reply cap of one token (OpenAI: 16, its
// minimum), no system prompt, no tools, the raw path on Munin (never a persona). Nothing goes to the chat history or the
// action log; the caller sets the health mark (markAccountHealth with probe). Loaded after transport.js.
/* global anthropicHeaders, apiUrl, bearerHeaders, chatBody, MODELS_FETCH_TIMEOUT_MS, MUNIN_REASONING_EFFORT, openaiReasoningModel,
   providerFor, accountConfig, streamAnthropic, streamChat, streamResponses */
/* exported chatProbeOn, probeChat, probeRequest, PROBE_PROMPT */

// Whether explicit checks send the probe at all (the tests switch it off unless they ask for it).
function chatProbeOn() { return true; }

const PROBE_PROMPT = 'ping';
const PROBE_TOKENS = { munin: 1, custom: 1, anthropic: 1, openai: 16 }; // the Responses API refuses max_output_tokens below 16

// The probe's request for the account's type (the same endpoints, headers and body fields as a chat request).
function probeRequest(snap) {
  const { prov, cfg } = snap;
  const user = [{ role: 'user', content: PROBE_PROMPT }];
  if (prov.id === 'openai') {
    const body = { model: cfg.model, input: user, max_output_tokens: PROBE_TOKENS.openai, stream: true, store: false };
    if (openaiReasoningModel(cfg.model)) body.reasoning = { effort: 'low' };
    return { kind: 'responses', url: apiUrl(snap, '/responses'), headers: bearerHeaders(cfg), body, tools: [] };
  }
  if (prov.id === 'anthropic') {
    const body = { model: cfg.model, max_tokens: PROBE_TOKENS.anthropic, messages: user, stream: true };
    return { kind: 'anthropic', url: apiUrl(snap, '/messages'), headers: anthropicHeaders(cfg), body, tools: [] };
  }
  const body = {
    model: cfg.model, persona: 'raw', max_tokens: PROBE_TOKENS[prov.id] || 1, stream: true, stream_options: { include_usage: true },
    messages: user, chat_template_kwargs: { reasoning_effort: MUNIN_REASONING_EFFORT },
  };
  return { kind: 'chat', url: apiUrl(snap, '/chat/completions'), headers: bearerHeaders(cfg), body: chatBody(prov, body), tools: [] };
}

// One probe of the account on the model: one attempt (no retries), the whole answer within timeoutMs. Resolves to
// { ok: true } or { ok: false, error } (error: the Error, err.status when the server answered; a time-out is an Error
// "no answer in 8 s"). snap.probe keeps postJson from setting the health mark: the caller decides it.
async function probeChat(a, model, { timeoutMs = MODELS_FETCH_TIMEOUT_MS } = {}) {
  const snap = { prov: providerFor(a, model), cfg: accountConfig(a, model), background: true, probe: true };
  const req = probeRequest(snap);
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    if (req.kind === 'responses') await streamResponses(req, signal, snap, {});
    else if (req.kind === 'anthropic') await streamAnthropic(req, signal, snap, {});
    else await streamChat(req, signal, snap, {});
    return { ok: true };
  } catch (e) {
    if (signal.aborted) {
      return { ok: false, error: new Error(`no answer in ${Math.round(timeoutMs / 1000)} s`) };
    }
    return { ok: false, error: e };
  }
}
