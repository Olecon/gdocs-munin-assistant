'use strict';
// Module transport.js: POST + SSE transport shared by all providers (postJson, readSseEvents,
// runStream with retries, abortableDelay) and error mapping (apiError).
/* global fullModelId, markAccountHealth, noteOmittedField, OMITTABLE_FIELDS, serverAccess, serverHost, setStatus, state, STREAM_RETRY_DELAYS_MS, STREAM_RETRY_STATUS, streamAnthropic, streamChat, streamResponses */
/* exported apiError, errorWords, errorClause, rawError, postJson, readSseEvents, readStream, streamError, runStream */

// ---------------------------------------------------------------------------
// Transport: POST + SSE parsing shared by all providers
// ---------------------------------------------------------------------------
// Builds a readable Error from a non-2xx response. err.showSettings marks key/model problems;
// err.quota marks an exhausted quota (Munin's HTTP 429 is its monthly quota; OpenAI's 429 with the
// error code insufficient_quota is an empty balance): runStream never retries those.
// err.maintenance marks Munin's nightly maintenance window (HTTP 503 with next_start): not retried either.
// err.contextLength marks a request the server refused as too long for the context window (HTTP 400).
// err.status, err.serverMessage and err.serverCode keep the raw details.
async function apiError(resp, snap) {
  const { prov, cfg } = snap;
  let body = '';
  let j = null;
  try { body = await resp.text(); } catch (e) { /* ignore */ }
  try { j = JSON.parse(body); } catch (e) { /* not JSON */ }
  const serverMsg = (j && j.error && (typeof j.error === 'string' ? j.error : j.error.message)) ||
    (j && j.message) || body.slice(0, 300);
  const serverCode = (j && j.error && typeof j.error === 'object' && String(j.error.code || j.error.type || '')) || '';
  const server = serverMsg ? ` Server: ${serverMsg}` : '';
  let msg;
  let showSettings = false;
  let quota = false;
  let maintenance = false;
  let contextLength = false;
  if (resp.status === 401) {
    msg = `Invalid ${prov.label} API key (HTTP 401). ${prov.keyHint} Then paste it into the extension settings.`;
    showSettings = true;
  } else if (resp.status === 404 && prov.id !== 'munin') {
    msg = `Not found (HTTP 404): the model "${cfg.model}" is not offered. Choose another one in the model menu under the input box.${server}`;
    showSettings = true;
  } else if (resp.status === 429 && prov.id === 'munin') {
    const reset = localTime(j && (j.reset_at || j.resets_at || (j.error && typeof j.error === 'object' && (j.error.reset_at || j.error.resets_at))));
    msg = `The monthly token quota of this Munin API key is used up (HTTP 429)${reset ? `; it resets on ${reset}` : ''}. Check your usage in Munin Chat → Settings.`;
    quota = true;
  } else if (resp.status === 503 && prov.id === 'munin' && j && j.next_start) {
    // Munin's nightly maintenance window (02:00–06:00 Europe/Berlin): a retry in a few seconds cannot help.
    const back = localTime(j.next_start);
    const after = retryAfterSeconds(resp);
    msg = back ? `Munin is in its nightly maintenance window; it is back at ${back}.`
      : after ? `Munin is in its nightly maintenance window; it is back in about ${Math.max(1, Math.round(after / 60))} min.`
        : 'Munin is in its nightly maintenance window (HTTP 503); try again later.';
    maintenance = true;
  } else if (resp.status === 429 && prov.id === 'openai' && (serverCode === 'insufficient_quota' || /insufficient_quota/.test(body))) {
    msg = `OpenAI quota exhausted (HTTP 429): the account has no credit left. Check your plan and billing at platform.openai.com.${server}`;
    quota = true;
  } else if (resp.status === 429) {
    msg = `Rate limit or quota exceeded (HTTP 429). Check your ${prov.label} plan, usage and billing.${server}`;
  } else if (resp.status === 400 && /context (window|length)|context_length|too long|too large|maximum context|exceeds? the (context|maximum)|tokens? exceed|reduce the length/i.test(serverMsg || '')) {
    msg = 'The request does not fit into the model\'s context window (HTTP 400). The document is too large: ' +
      'shorten it or work on a smaller part, or start a new chat to drop the history.' + server;
    contextLength = true;
  } else {
    msg = `API error ${resp.status}${serverMsg ? ': ' + serverMsg : ''}`;
  }
  const err = new Error(msg);
  err.showSettings = showSettings;
  err.status = resp.status;
  err.serverMessage = serverMsg || '';
  err.serverCode = serverCode;
  if (quota) err.quota = true;
  if (maintenance) err.maintenance = true;
  if (contextLength) err.contextLength = true; // toolLoop and the compaction retry once with less context
  return err;
}

// ---- What the model and the chat see of an error ------------------------------------------------------------------
// One sentence in plain words that says what to do: no HTTP code and no server text (the raw message stays in the
// console, the health mark and the result's _rawError for the chat log). From the error's flags: network (no
// response), preSend (our own refusal: its message is already plain), google (a Docs API response: docsApiError) and
// status. A 400 keeps a short cleaned reason, which helps the model fix its call. Provider errors (apiError) keep
// their advice without the code and the server's words.
function errorWords(e) {
  if (!e) return 'Something went wrong; try again.';
  if (e.name === 'AbortError') return 'Stopped.';
  const s = Number(e.status) || 0;
  if (e.noAccess) return e.message; // Chrome's permission for the account's server: already plain, says what to do
  if (e.network) return e.google ? 'Google did not answer; try again in a moment.' : 'Could not reach the model server. Check your connection (and a VPN or proxy, if any).';
  if (e.google && s) {
    if (s === 401) return 'Sign in to Google again in the settings.';
    if (s === 403) return e.advice ? sentence(e.advice) : 'This Google account has no access to the document.';
    if (s === 404) return 'This Google account has no access to the document.';
    if (s === 429) return 'Google got too many requests; wait a minute and try again.';
    if (s >= 500) return 'Google did not answer; try again in a moment.';
    if (s === 400) return malformedWords(e.serverMessage);
    return 'Google refused the request; try again.';
  }
  if (s >= 500 && !e.maintenance) return 'The model server did not answer; try again in a moment.';
  if (s === 400 && !e.showSettings && !/context window/.test(String(e.message))) return malformedWords(e.serverMessage);
  return sentence(withoutCodes(e.message || String(e))) || 'Something went wrong; try again.';
}
// The same as a clause inside a sentence: "(… )" or after a colon (no capital, no final period).
// Names (Google, Munin, Chrome, a model's) keep their capital.
const errorClause = (e) => { const w = errorWords(e).replace(/\.$/, ''); return /^(?:The|This|Could|Sign|Something|Stopped|No|Not)\b/.test(w) ? w.charAt(0).toLowerCase() + w.slice(1) : w; };
// The raw text of an error for the chat log and the console (_rawError on a tool result).
const rawError = (e) => String((e && (e.raw || e.message)) || e || '');
// A message without its codes and the server's words: "(HTTP 401)", "HTTP 403: ", "API error 500: …", " Server: …".
function withoutCodes(t) {
  return String(t).replace(/\s*(?:Server|Google): [\s\S]*$/, '').replace(/\s*\((?:HTTP )?\d{3}(?:;[^)]*)?\)/g, '')
    .replace(/\b(?:Google Docs API error|API error|HTTP) \d{3}:?\s*/g, '').replace(/\s+([.,;:])/g, '$1').trim();
}
const sentence = (t) => { const s = String(t || '').trim(); return s ? s.charAt(0).toUpperCase() + s.slice(1) + (/[.!?…]$/.test(s) ? '' : '.') : ''; };
// "The request was malformed: <reason>": the server's reason without codes or a JSON dump, cut to 200 characters
// ("Invalid requests[0].insertText: …" stays: it names the operation).
function malformedWords(server) {
  let r = withoutCodes(String(server || '')).replace(/[{}"[\]]{2,}.*$/s, '').replace(/\s+/g, ' ').trim();
  if (r.length > 200) r = r.slice(0, 199) + '…';
  return r ? `The request was malformed: ${r}${/[.!?…]$/.test(r) ? '' : '.'}` : 'The request was malformed.';
}

// An ISO time from a server body as a short local date and time in the user's locale, or '' when unreadable.
function localTime(iso) {
  if (typeof iso !== 'string' && typeof iso !== 'number') return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
// Retry-After in seconds (only the delay-seconds form), or 0.
function retryAfterSeconds(resp) {
  let v = '';
  try { v = (resp.headers && typeof resp.headers.get === 'function' && resp.headers.get('retry-after')) || ''; } catch (e) { /* no headers */ }
  return /^\d+$/.test(String(v).trim()) ? Number(v) : 0;
}

// CRLF/CR -> LF for SSE parsing. A trailing "\r" is kept until the next network read, because
// a "\r\n" split across two reads would otherwise turn into two newlines (a phantom blank line).
function normalizeNewlines(s) {
  return s.replace(/\r\n/g, '\n').replace(/\r(?!$)/g, '\n');
}

// POSTs the request's JSON body. Returns the Response (with a body stream) or throws a readable Error.
// The account's health mark (settings.js markAccountHealth) follows: no answer or HTTP 5xx marks it down, a rejected
// key makes it unknown, any other answer reachable. Not for a chat probe (snap.probe, probe.js): its caller sets the mark.
// A custom server's 400 that names a field it does not support (OMITTABLE_FIELDS) is sent once more without it; the
// account leaves the field out from then on (noteOmittedField).
async function postJson(req, signal, snap) {
  const cfg = (snap && snap.cfg) || {};
  const accountId = cfg.accountId;
  const marks = !!accountId && !(snap && snap.probe);
  let resp;
  try {
    resp = await fetch(req.url, { method: 'POST', signal, headers: req.headers, body: JSON.stringify(sentBody(req, snap)) });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    const err = new Error(`Could not reach ${req.url} (${e.message}). Check your connection (and a VPN or proxy, if any).`);
    err.network = true; // no response at all: runStream may retry
    err.cause = e;
    // The account's own server without Chrome's permission: CORS stopped it; waiting does not help, the settings do.
    if (cfg.baseUrl && !(await serverAccess(cfg.baseUrl))) {
      err.message = `Chrome did not let the panel reach ${serverHost(cfg.baseUrl)}. Open the settings and click Check provider on ${cfg.name || 'this provider'} to allow it.`;
      err.noAccess = true;
    }
    if (marks) markAccountHealth(accountId, err);
    throw err;
  }
  if (!resp.ok) {
    const err = await apiError(resp, snap);
    if (marks) markAccountHealth(accountId, err);
    const field = refusedField(resp.status, err, req, snap);
    if (!field) throw err;
    cfg.omit = [...(cfg.omit || []), field];
    noteOmittedField(accountId, field);
    const prev = state.statusText;
    if (!snap.background) setStatus(`${cfg.name || snap.prov.label} does not support ${field}; retrying without it…`);
    try { return await postJson(req, signal, snap); } finally { if (!snap.background) setStatus(prev.text, prev.warn); }
  }
  if (marks) markAccountHealth(accountId, null);
  if (!resp.body) throw new Error('The server returned an empty response.');
  return resp;
}

const isCustomChat = (req, snap) => !!(snap && snap.prov && snap.prov.id === 'custom' && snap.cfg && req.kind === 'chat' && req.body);
// The body as sent: a custom server's request without the fields it refused before (cfg.omit), its model as the full
// id (cfg.modelPrefix: the requests are built with the short id the chat names).
function sentBody(req, snap) {
  const cfg = (snap && snap.cfg) || {};
  const omit = isCustomChat(req, snap) && cfg.omit;
  const full = cfg.modelPrefix && req.body && typeof req.body.model === 'string' ? fullModelId(cfg, req.body.model) : '';
  if ((!omit || !omit.length) && (!full || full === req.body.model)) return req.body;
  const body = { ...req.body };
  if (full) body.model = full;
  for (const f of omit || []) delete body[f];
  return body;
}
// The field a custom server's HTTP 400 names (word match in its message or code) that the body still carries, or ''.
function refusedField(status, err, req, snap) {
  if (status !== 400 || !isCustomChat(req, snap)) return '';
  const said = `${err.serverMessage || ''} ${err.serverCode || ''}`;
  const omitted = snap.cfg.omit || [];
  return OMITTABLE_FIELDS.find((f) => f in req.body && !omitted.includes(f) && new RegExp(`\\b${f}\\b`).test(said)) || '';
}

// Reads an SSE body and calls onEvent(eventName, data) per event, where data is the parsed JSON of
// the "data:" line(s). Line-based: works whether or not events are separated by blank lines; a
// partial line stays buffered until the next network read completes it; data lines that do not
// parse on their own are joined with the following ones (multi-line events). "event:" sets the name
// for the following data line(s). "[DONE]" is passed as the string '[DONE]'; other data that never parses is dropped
// at the end of its event.
async function readSseEvents(resp, onEvent) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let event = '';
  let pending = [];
  const onLine = (line) => {
    if (line === '') { event = ''; pending = []; return; } // end of event
    if (line.startsWith('event:')) { event = line.slice(6).trim(); pending = []; return; }
    if (!line.startsWith('data:')) return; // id:, retry:, comments
    const data = line.slice(5).replace(/^ /, '');
    if (!pending.length && data.trim() === '[DONE]') { onEvent(event, '[DONE]'); return; }
    pending.push(data);
    let parsed;
    try { parsed = JSON.parse(pending.join('\n')); } catch (e) { return; }
    pending = [];
    onEvent(event, parsed);
  };
  const drain = () => {
    buf = normalizeNewlines(buf);
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      onLine(line);
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    drain();
  }
  buf += decoder.decode();
  if (buf.trim()) { buf += '\n'; drain(); }
}

// readSseEvents for a provider's stream parser: an error thrown meanwhile (Stop, a network failure, the parser's
// own) carries what was received so far (partial()) unless it has it already.
async function readStream(resp, onEvent, partial) {
  try {
    await readSseEvents(resp, onEvent);
  } catch (e) {
    if (!e.partial) e.partial = partial();
    throw e;
  }
}
// A stream failure with what was received so far.
const streamError = (msg, partial) => Object.assign(new Error(msg), { partial: partial() });

// Runs the streaming request for a non-persona turn with the client that matches req.kind.
// All clients take the same hooks { onReasoning(text), onContent(text), onToolCall(index, call) }
// and return the same result shape:
//   { content, reasoning, toolCalls: [{id, type: 'function', function: {name, arguments}}],
//     finishReason: 'stop' | 'tool_calls' | 'length' | 'refusal' | ..., usage: {prompt_tokens, completion_tokens, total_tokens, ...},
//     raw?: { key, items } (provider output to replay in the next round), servedBy?, stopDetails? }
// On abort/error they throw an exception with a .partial field holding what was received so far.
// Transient failures before anything was streamed (isTransientStreamError) are retried after each of
// STREAM_RETRY_DELAYS_MS; a Stop during the wait ends it at once and rethrows the error (callers check
// signal.aborted).
async function runStream(req, signal, snap, hooks) {
  for (let attempt = 0; ; attempt++) {
    try {
      if (req.kind === 'responses') return await streamResponses(req, signal, snap, hooks);
      if (req.kind === 'anthropic') return await streamAnthropic(req, signal, snap, hooks);
      return await streamChat(req, signal, snap, hooks);
    } catch (e) {
      const delay = STREAM_RETRY_DELAYS_MS[attempt];
      if (delay == null || signal.aborted || !isTransientStreamError(e)) throw e;
      // A background job (snap.background: the first-run pass of doc-init.js) leaves the status line to the turn.
      const quietWait = !!(snap && snap.background);
      const prev = state.statusText;
      const what = e.network ? 'connection failed' : `is busy (HTTP ${e.status})`;
      if (!quietWait) setStatus(`${snap.prov.label} ${what}; retrying in ${Math.round(delay / 1000)} s…`, true);
      const aborted = await abortableDelay(delay, signal);
      if (!quietWait) setStatus(prev.text, prev.warn);
      if (aborted) throw e;
    }
  }
}

// Retryable: HTTP STREAM_RETRY_STATUS or a failed fetch (postJson sets e.network), and nothing streamed
// (stream errors carry .partial, HTTP and fetch errors do not). An exhausted quota (e.quota) is not
// transient: waiting a few seconds does not help; neither does Munin's maintenance window (e.maintenance).
// Nor is a server Chrome blocks (e.noAccess: no host permission).
const isTransientStreamError = (e) => !!e && !e.partial && e.name !== 'AbortError' && !e.quota && !e.maintenance && !e.noAccess &&
  (e.network === true || STREAM_RETRY_STATUS.has(e.status));

// Resolves false after ms, or true at once when the signal aborts.
function abortableDelay(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(true); return; }
    const onAbort = () => { clearTimeout(t); resolve(true); };
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(false); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
