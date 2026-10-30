'use strict';
// Module transport.js: POST + SSE transport shared by all providers (postJson, readSseEvents,
// runStream with retries, abortableDelay) and error mapping (apiError).
/* global el, setStatus, STREAM_RETRY_DELAYS_MS, STREAM_RETRY_STATUS, streamAnthropic, streamChat, streamResponses */
/* exported apiError, postJson, readSseEvents, readStream, streamError, runStream */

// ---------------------------------------------------------------------------
// Transport: POST + SSE parsing shared by all providers
// ---------------------------------------------------------------------------
// Builds a readable Error from a non-2xx response. err.showSettings marks key/model problems;
// err.quota marks an exhausted quota (Munin's HTTP 429 is its monthly quota; OpenAI's 429 with the
// error code insufficient_quota is an empty balance): runStream never retries those.
// err.maintenance marks Munin's nightly maintenance window (HTTP 503 with next_start): not retried either.
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
  if (resp.status === 401) {
    msg = `Invalid ${prov.label} API key (HTTP 401). ${prov.keyHint} Then paste it into the extension settings.`;
    showSettings = true;
  } else if (resp.status === 404 && prov.id !== 'munin') {
    msg = `Not found (HTTP 404): check the Model ("${cfg.model}") in settings (click Check models).${server}`;
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
  } else if (resp.status === 400 && /context|too long|too large|maximum|exceed/i.test(serverMsg || '')) {
    msg = 'The request does not fit into the model\'s context window (HTTP 400). The document is too large: ' +
      'shorten it or work on a smaller part, or start a new chat to drop the history.' + server;
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
  return err;
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
async function postJson(req, signal, snap) {
  let resp;
  try {
    resp = await fetch(req.url, { method: 'POST', signal, headers: req.headers, body: JSON.stringify(req.body) });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    const err = new Error(`Could not reach ${req.url} (${e.message}). Check your connection (and a VPN or proxy, if any).`);
    err.network = true; // no response at all: runStream may retry
    throw err;
  }
  if (!resp.ok) throw await apiError(resp, snap);
  if (!resp.body) throw new Error('The server returned an empty response.');
  return resp;
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
      const prev = { text: el.docStatus.textContent, warn: el.docStatus.classList.contains('warn') };
      const what = e.network ? 'connection failed' : `is busy (HTTP ${e.status})`;
      setStatus(`${snap.prov.label} ${what}; retrying in ${Math.round(delay / 1000)} s…`, true);
      const aborted = await abortableDelay(delay, signal);
      setStatus(prev.text, prev.warn);
      if (aborted) throw e;
    }
  }
}

// Retryable: HTTP STREAM_RETRY_STATUS or a failed fetch (postJson sets e.network), and nothing streamed
// (stream errors carry .partial, HTTP and fetch errors do not). An exhausted quota (e.quota) is not
// transient: waiting a few seconds does not help; neither does Munin's maintenance window (e.maintenance).
const isTransientStreamError = (e) => !!e && !e.partial && e.name !== 'AbortError' && !e.quota && !e.maintenance &&
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
