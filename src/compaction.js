'use strict';
// Module compaction.js: history compaction at the start of a turn (compactionPlan, compactionBudget,
// maybeCompact: folding first (foldPlan, foldEntry), then buildSummaryRequest), the same in the background after a
// turn near the trigger (backgroundCompact) and history slimming after a turn (slimHistory).
/* global canRequest, chatBody, activeConfig, activeProvider, BACKGROUND_COMPACT_RATIO, chatLockIfFree, docStatusText, nextRequestEstimate, readChatForTurn,
   renderContextGauge, renderHistoryKeepingUnstored, snapshotDocument,
   activeHistory, addLateTurnRow, addTurnRow, anthropicHeaders, apiUrl, bearerHeaders, buildApiMessages,
   buildSystemParts, cachesPrompt, CHARS_PER_TOKEN, CONTEXT_RETRY_SCALE, COMPACT_AT_TOKENS, MUNIN_COMPACT_AT_TOKENS, COMPACT_MSG_CHARS, COMPACT_PROMPT,
   COMPACT_TOOL_CHARS, COMPACTED_TOOL_KEEP_CHARS, COMPACTED_TOOL_MARKER, estimateTokens,
   FOLD_ARG_VALUE_CHARS, FOLD_ARGS_CHARS, FOLD_ERROR_CHARS, FOLD_HEADROOM_TOKENS, FOLD_NOTE,
   fitMessages, fmtNum, isReadingTool, LOG_KEEP_CHARS, LOG_KEEP_CUT_NOTE, LOG_KEEP_TURNS, RAW_REPLAY_KEYS, joinSystem, lastUserIndex, PERSONA_DOC_CHAR_LIMIT,
   readingStub, runStream, saveHistory, setStatus, shortContext, state, STUB_MIN_CHARS, SUMMARY_PREFIX, SUMMARY_PREFIX_RE,
   SUMMARY_RESERVE_TOKENS, sentTools, tokenBudget, MUNIN_REASONING_EFFORT, samplingFields, toolNamesById, toolsFor, applyTurnMode */
/* exported compactionBudget, foldCall, maybeCompact, backgroundCompact, slimHistory, requestTokens */

// ---------------------------------------------------------------------------
// History compaction: at the start of a turn (never between tool rounds, so that the request prefix
// stays stable within a turn for Anthropic thinking blocks and prompt caching), when the turn's first
// request is over budget and at least two older turns exist, the oldest turns are summarized by the
// active provider (same model, no tools). The summary is inserted as a user message
// (SUMMARY_PREFIX, _summary, _covers: n) before the first message it did not
// replace; the replaced messages get _compacted (kept for display, never sent). If the summary request
// fails, the old trimming applies (fitMessages) with a row of the turn.
// Before any summary request the old turns are folded (no request): when the folded history fits, the fold
// takes the summary's place (the same message shape, plus _folded) and no summary is requested. With one older turn
// only the fold is tried (compactionPlan's foldOnly), else trimming applies.
// ---------------------------------------------------------------------------
// The messages to summarize (a prefix of the active history ending at a turn boundary), or null.
// No plan when the history is not what overflows: if the request with the history reduced to the current
// turn (plus the previous summary) still does not fit, the prompt itself (the document instructions, a
// long selection, or the excerpt of a Munin persona turn) is the cause, and a summary would only be redone
// on every turn; trimming and the document cut handle that. The part to summarize must also be worth a
// request (> 2 x SUMMARY_RESERVE_TOKENS).
// budget: the trigger to plan against (default compactionBudget; the background compaction passes a lower one).
function compactionPlan(mode, snap, budget = compactionBudget(mode, snap)) {
  const active = activeHistory(state.messages);
  const lastUser = lastUserIndex(active);
  if (lastUser < 0 || !fitMessages(mode, snap, { budget }).trimmed) return null;
  // A summary counts as one; an automatic continuation (_auto) is part of its turn.
  const olderTurns = active.slice(0, lastUser).filter((m) => m.role === 'user' && !m._auto).length;
  if (!olderTurns) return null;
  const minimal = [...active.slice(0, lastUser).filter((m) => m._summary).slice(-1), ...active.slice(lastUser)];
  if (requestTokens(mode, snap, minimal) > budget - SUMMARY_RESERVE_TOKENS) return null;
  // One huge earlier turn (its tool results, usually): trimming would drop it whole, a summary of one turn is not worth
  // a request, its fold keeps the user's text, the calls and the answer. foldOnly: no summary when the fold is not enough.
  if (olderTurns === 1) {
    const older = active.slice(0, lastUser);
    if (older[0]._summary || estimateTokens(older) <= 2 * SUMMARY_RESERVE_TOKENS) return null;
    return Object.assign(older, { foldOnly: true });
  }
  // Drop as much as trimming would, with room for the summary, and extend to the start of a turn.
  let cut = active.length - fitMessages(mode, snap, { budget, reserve: SUMMARY_RESERVE_TOKENS }).history.length;
  while (cut < lastUser && (active[cut].role !== 'user' || active[cut]._auto)) cut++; // _auto belongs to its turn
  if (cut <= 0) return null;
  const dropped = active.slice(0, cut);
  return estimateTokens(dropped) > 2 * SUMMARY_RESERVE_TOKENS ? dropped : null;
}

// The size at which a turn compacts the history: COMPACT_AT_TOKENS for OpenAI and Anthropic (far below
// their context window: a long history costs input tokens on every request), MUNIN_COMPACT_AT_TOKENS for Munin (a 27B
// model follows a request of 40k tokens better than one of 55k; the fold, which needs no request, comes first), the
// context budget for custom servers (unknown model, no known prompt cache).
// Trimming (the fallback) still uses the full context budget (tokenBudget).
function compactionBudget(mode, snap) {
  const hard = tokenBudget(mode, snap);
  if (cachesPrompt(snap.prov)) return Math.min(hard, COMPACT_AT_TOKENS);
  return snap.prov.id === 'munin' ? Math.min(hard, MUNIN_COMPACT_AT_TOKENS) : hard;
}

// Estimated size of a request with the full prompt (no document cut) and the given history.
function requestTokens(mode, snap, history) {
  const tools = toolsFor(mode, snap);
  const system = joinSystem(buildSystemParts(mode, PERSONA_DOC_CHAR_LIMIT, snap));
  return estimateTokens(buildApiMessages(tools.length > 0, history, system, { shortOld: !cachesPrompt(snap.prov) }),
    tools.length ? JSON.stringify(sentTools(tools, snap.prov)).length : 0);
}

// Plain-text transcript of the messages to summarize (long texts clipped; capped to CONTEXT_RETRY_SCALE of the budget:
// chars/3 can underestimate, and a refused summary disables compaction for the session). share: the part of that cap
// to use (half for the retry after the server refused the summary request as too long).
function compactionTranscript(msgs, mode, snap, share = 1) {
  const clip = (t, n) => { const s = String(t == null ? '' : t); return s.length > n ? `${s.slice(0, n)} [... ${fmtNum(s.length - n)} more characters]` : s; };
  const out = [];
  for (const m of msgs) {
    if (m.role === 'user') {
      if (m._auto) { out.push(autoNote(m)); continue; } // the panel's request, not the user's words
      // The turn context (outline, selection) only in its short form: positions and sizes, no outline.
      const ctx = typeof m._context === 'string' && m._context ? `\n[Document state when sent: ${clip(shortContext(m._context).replace(/\s+/g, ' '), COMPACT_TOOL_CHARS)}]` : '';
      out.push(m._summary ? `Summary of an even earlier part:\n${summaryBody(m)}` : `User: ${clip(m.content, COMPACT_MSG_CHARS)}${ctx}`);
    } else if (m.role === 'assistant') {
      if (m._wrapUp) out.push(WRAP_UP_NOTE);
      if ((m.content || '').trim()) out.push(`Assistant: ${clip(m.content, COMPACT_MSG_CHARS)}`);
      for (const tc of m.tool_calls || []) out.push(`Assistant called ${tc.function.name}(${clip(tc.function.arguments || '', COMPACT_TOOL_CHARS)})`);
    } else if (m.role === 'tool') {
      const note = m._decision === 'rejected' || m._decision === 'stopped' ? ' (the user did not allow opening this document)' : '';
      out.push(`Tool result${note}: ${clip(m.content, COMPACT_TOOL_CHARS)}`);
    }
  }
  const text = out.join('\n\n');
  const max = Math.max(4000, Math.floor(share * (CONTEXT_RETRY_SCALE * (tokenBudget(mode, snap) - 2000) * CHARS_PER_TOKEN - COMPACT_PROMPT.length)));
  return text.length > max ? `${text.slice(0, max)}\n[... the rest of this part of the conversation is left out: too long]` : text;
}
// The transcript for the retry after a too-long summary request: the older half of the turns folded (as the fold
// stage writes them, no request), the newer half as usual, within half the cap.
function halvedTranscript(msgs, mode, snap) {
  let cut = Math.floor(msgs.length / 2);
  while (cut < msgs.length && (msgs[cut].role !== 'user' || msgs[cut]._auto)) cut++; // whole turns only
  const parts = cut > 0 ? [foldEntry(msgs.slice(0, cut)), ...msgs.slice(cut)] : msgs;
  return compactionTranscript(parts, mode, snap, 0.5);
}

// The summarization request for the turn's provider: a plain request without tools, streamed like any
// other (runStream), with the summarization prompt as the system prompt.
function buildSummaryRequest(snap, transcript) {
  const { prov, cfg } = snap;
  const user = `<conversation>\n${transcript}\n</conversation>\n\nSummarize the conversation above as instructed.`;
  if (prov.id === 'openai') {
    const body = { model: cfg.model, instructions: COMPACT_PROMPT, input: [{ role: 'user', content: user }], max_output_tokens: prov.maxTokens, stream: true, store: false };
    return { kind: 'responses', url: apiUrl(snap, '/responses'), headers: bearerHeaders(cfg), body, tools: [] };
  }
  if (prov.id === 'anthropic') {
    const body = { model: cfg.model, max_tokens: prov.maxTokens, system: COMPACT_PROMPT, messages: [{ role: 'user', content: user }], stream: true };
    return { kind: 'anthropic', url: apiUrl(snap, '/messages'), headers: anthropicHeaders(cfg), body, tools: [] };
  }
  const body = {
    model: cfg.model, persona: 'raw', max_tokens: prov.maxTokens, stream: true, stream_options: { include_usage: true },
    messages: [{ role: 'system', content: COMPACT_PROMPT }, { role: 'user', content: user }],
    // A summary needs neither deep thinking nor variety (Munin would inject "medium" effort and get the prose sampling).
    chat_template_kwargs: { reasoning_effort: MUNIN_REASONING_EFFORT }, ...samplingFields(prov, 'summary'),
  };
  return { kind: 'chat', url: apiUrl(snap, '/chat/completions'), headers: bearerHeaders(cfg), body: chatBody(prov, body), tools: [] };
}

// ---- Folding: the summary without a request ----------------------------------------------------------
// The fold of the planned messages, or of more whole turns (up to all turns before the current one), that
// keeps the turn's first request FOLD_HEADROOM_TOKENS below the compaction trigger: { msgs, entry }, or null
// when even folding every older turn is not enough (the user texts and answers themselves are too long).
// More turns than planned cost nothing extra: the fold rewrites the start of the history either way.
function foldPlan(mode, snap, planned, budget = compactionBudget(mode, snap)) {
  const limit = budget - FOLD_HEADROOM_TOKENS;
  const active = activeHistory(state.messages);
  const lastUser = lastUserIndex(active);
  for (let cut = planned.length; cut <= lastUser; cut++) {
    if (active[cut].role !== 'user' || active[cut]._auto) continue; // whole turns only (_auto belongs to its turn)
    const msgs = active.slice(0, cut);
    const entry = foldEntry(msgs);
    if (requestTokens(mode, snap, [entry, ...active.slice(cut)]) <= limit) return { msgs, entry };
  }
  return null;
}

// The fold message: a summary message (_summary, _covers) marked _folded, so that it is sent, shown and
// summarized later exactly like a summary written by the model.
function foldEntry(msgs) {
  return { role: 'user', content: `${SUMMARY_PREFIX}\n${FOLD_NOTE}\n\n${foldText(msgs)}`, _summary: true, _folded: true, _covers: msgs.length };
}

// How the panel's own requests (_auto) appear in a fold or a summary transcript: the length continuation, and the
// wrap-up at the round limit (after its turn only the answer's _wrapUp mark is left of it) and the nudge while their
// turn runs.
const AUTO_CONTINUED_NOTE = '[The reply was cut by the length limit and continued.]';
const WRAP_UP_NOTE = '[The tool budget of this message ran out; the assistant summarized what was done and what is left.]';
const NUDGE_NOTE = '[The assistant announced an edit without calling a tool and was reminded.]';
// An agent's report (agents.js) is data the later turns may need: its text, clipped. A revert's row (accounts.js) says
// which model the chat runs on: its text. A failed turn's note (turn.js noteFailedTurn): its text, already bracketed.
const autoNote = (m) => (m._revert ? `[${m.content}]` : m._failed ? String(m.content || '') : m._autoKind === 'agent-report' ? agentReportNote(m) : m._autoKind === 'wrap-up' ? WRAP_UP_NOTE : m._autoKind === 'nudge' ? NUDGE_NOTE : AUTO_CONTINUED_NOTE);
function agentReportNote(m) {
  const t = String(m.content || '').trim();
  return t.length > COMPACT_MSG_CHARS ? `${t.slice(0, COMPACT_MSG_CHARS)} [... ${fmtNum(t.length - COMPACT_MSG_CHARS)} more characters]` : t;
}

// A summary's text without its prefix (and a fold's note).
const summaryBody = (m) => String(m.content || '').replace(SUMMARY_PREFIX_RE, '').replace(FOLD_NOTE, '').trim();

// The folded transcript. Per turn: the user's text (an earlier summary or fold as it is), one line per tool
// call ("[read_document(scope={...}): ok]"; a failed call with the start of its error) and the turn's final
// answer. The turn context of a user message is left out: it described the document as it was then.
// Intermediate texts between tool rounds are left out too; the final answer carries the conclusions.
function foldText(msgs) {
  const results = new Map();
  for (const m of msgs) if (m.role === 'tool') results.set(m.tool_call_id, m);
  const out = [];
  let answer = '';
  const endTurn = () => { if (answer) out.push(`Assistant: ${answer}`); answer = ''; };
  for (const m of msgs) {
    if (m.role === 'user' && m._auto) {
      // The panel's request in the middle of a turn, not the user's words: the turn goes on.
      out.push(autoNote(m));
    } else if (m.role === 'user') {
      endTurn();
      out.push(m._summary ? (m._folded ? summaryBody(m) : `Summary of an even earlier part: ${summaryBody(m)}`) : `User: ${m.content}`);
    } else if (m.role === 'assistant') {
      if (m._wrapUp && !(out.length && out[out.length - 1] === WRAP_UP_NOTE)) out.push(WRAP_UP_NOTE);
      for (const tc of m.tool_calls || []) out.push(foldCall(tc, results.get(tc.id)));
      if ((m.content || '').trim()) answer = m.content.trim();
    }
  }
  endTurn();
  return out.join('\n');
}

const foldClip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// One tool call and its result as one line.
function foldCall(tc, result) {
  const fn = tc.function || {};
  const head = `${fn.name}(${foldArgs(fn.arguments)})`;
  if (!result) return `[${head}]`;
  const text = String(result.content || '').replace(/\s+/g, ' ').trim();
  if (result._ok === false || /^Error:/.test(text)) {
    return `[${head}: ${foldClip(/^Error:/.test(text) ? text : `failed: ${text}`, FOLD_ERROR_CHARS)}]`;
  }
  return `[${head}: ${result._edit && result._edit.undone ? 'ok, undone later' : 'ok'}]`;
}

// Arguments as "k=v, ..." (nulls left out, every value cut, all of them cut again); unparsable ones as sent.
function foldArgs(raw) {
  let args = null;
  try { args = JSON.parse(raw || '{}'); } catch (e) { args = null; }
  const text = args && typeof args === 'object' && !Array.isArray(args)
    ? Object.entries(args).filter(([, v]) => v != null).map(([k, v]) => `${k}=${foldClip(JSON.stringify(v), FOLD_ARG_VALUE_CHARS)}`).join(', ')
    : String(raw || '').replace(/\s+/g, ' ');
  return foldClip(text, FOLD_ARGS_CHARS);
}

// Marks the replaced messages (the arrays are shared with the chat context: modified in place) and puts
// the summary or fold entry right after the last of them. _edit journals stay: undo reads them from
// state.messages, compacted or not.
function replaceWithSummary(msgs, entry) {
  const replaced = new Set(msgs);
  let at = 0;
  state.messages.forEach((m, i) => {
    if (!replaced.has(m)) return;
    m._compacted = true;
    at = i + 1;
    // Cut only after the summary or fold was made (it needed the full text); the chat log copy keeps it (_log).
    if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > COMPACTED_TOOL_KEEP_CHARS) {
      keepLogText(m, m.content);
      m.content = m.content.slice(0, COMPACTED_TOOL_KEEP_CHARS) + COMPACTED_TOOL_MARKER;
    }
  });
  state.messages.splice(at, 0, entry);
}

// Runs a compaction if the turn needs one. Returns true when the history was compacted. Folding comes
// first and needs no request; when the fold is not enough, the planned messages (not their fold: the
// summary can keep facts from successful results that the fold drops) are summarized. A Stop during the
// summary request ends the turn (the AbortError is rethrown); any other failure leaves the history as it
// was (the request is trimmed as before) and adds a row of the turn.
// budget: the trigger to compact against (default compactionBudget; see backgroundCompact).
async function maybeCompact(mode, snap, signal, ctx, { budget = compactionBudget(mode, snap) } = {}) {
  const msgs = compactionPlan(mode, snap, budget);
  if (!msgs) return false;
  const fold = foldPlan(mode, snap, msgs, budget);
  if (fold) {
    replaceWithSummary(fold.msgs, fold.entry);
    await saveHistory(ctx);
    return true;
  }
  if (msgs.foldOnly) return false; // one earlier turn: trimming, as before
  if (state.compactionFailedChat === ctx.chatId) return false; // failed earlier in this session: trimming only
  setStatus('Summarizing the earlier conversation…');
  let summary = '';
  let usage = null;
  try {
    let r;
    try {
      r = await runStream(buildSummaryRequest(snap, compactionTranscript(msgs, mode, snap)), signal, snap, {});
    } catch (e) {
      if (!e.contextLength || e.partial || signal.aborted) throw e;
      r = await runStream(buildSummaryRequest(snap, halvedTranscript(msgs, mode, snap)), signal, snap, {}); // once
    }
    summary = String(r.content || '').trim();
    usage = r.usage || null;
    if (!summary) throw new Error(r.finishReason && r.finishReason !== 'stop' ? `the reply ended early (${r.finishReason})` : 'the reply was empty');
  } catch (e) {
    if (e.name === 'AbortError' || signal.aborted) throw e;
    if (ctx.messages !== state.messages) return false; // the panel moved to another chat meanwhile
    // Not retried in this chat until the chat is switched or the panel is reloaded (one row: of the turn, or after a
    // background compaction of the chat's last turn).
    state.compactionFailedChat = ctx.chatId;
    const why = e.contextLength ? 'the conversation is too long for the model even in half' : e.message;
    const text = `Could not summarize the earlier conversation (${why}); older messages are left out of the request instead ` +
      'for the rest of this chat session.';
    if (!addTurnRow(text)) addLateTurnRow(text, ctx.messages[ctx.messages.length - 1]);
    return false;
  }
  // Stopped, or the panel shows another chat (or a re-read history) by now: the summary is not applied.
  if (signal.aborted) throw Object.assign(new Error('Stopped.'), { name: 'AbortError' });
  if (ctx.messages !== state.messages) return false;
  const entry = { role: 'user', content: `${SUMMARY_PREFIX}\n${summary}`, _summary: true, _covers: msgs.length };
  if (usage) entry._usage = usage;
  replaceWithSummary(msgs, entry);
  await saveHistory(ctx);
  return true;
}

// ---- In the background after a turn -----------------------------------------------------------------
// sendMessage calls this after a turn when no queued message follows. When the estimate of the next request (the
// context gauge's own: nextRequestEstimate, so the two agree) is at or above BACKGROUND_COMPACT_RATIO of the
// compaction trigger, the compaction a turn would run at its start runs now, against that lower trigger, so the next
// message does not wait for it. It holds the chat lock (skipped when another tab holds it), starts from the stored
// history, and never starts while a turn or an Undo runs. Anything else in this panel that wants the chat's lock (Send,
// Undo, leaving or deleting the chat) aborts it first and waits for its end (yieldBackground in chats.js); a summary that
// arrives after that, or after a chat switch, is dropped. Returns the run's promise (resolving to true when the history
// was compacted), or null when it does not start.
function backgroundCompact() {
  if (state.busy || state.undoing || state.bgCompaction || state.loadingCtx) return null;
  const { docId, chatId } = state;
  if (!docId || !chatId) return null;
  const mode = applyTurnMode();
  let snap;
  let budget;
  try {
    snap = { prov: activeProvider(), cfg: { ...activeConfig() }, signal: null, docId };
    if (!canRequest(snap.cfg)) return null;
    snapshotDocument(snap);
    budget = Math.floor(BACKGROUND_COMPACT_RATIO * compactionBudget(mode, snap));
    if (nextRequestEstimate(mode, activeHistory(state.messages)) < budget) return null;
  } catch (e) {
    return null;
  }
  const abort = new AbortController();
  const run = { docId, chatId, abort, done: null };
  state.bgCompaction = run; // before the first await: a Send right now already finds it
  const free = () => !abort.signal.aborted && !state.busy && !state.undoing && state.docId === docId && state.chatId === chatId;
  run.done = (async () => {
    let release = null;
    try {
      release = await chatLockIfFree(docId, chatId);
      if (!release || !free()) return false; // another tab answers in this chat, or this panel moved on
      if (!(await readChatForTurn(docId, chatId)) || !free()) return false;
      const ctx = { docId, chatId, messages: state.messages };
      snap.chatCtx = ctx;
      const done = await maybeCompact(mode, snap, abort.signal, ctx, { budget });
      if (done && state.messages === ctx.messages) renderHistoryKeepingUnstored();
      return done;
    } catch (e) {
      return false; // stopped by a message, an Undo or a chat switch; a failed summary has its own row
    } finally {
      if (release) release();
      if (state.bgCompaction === run) state.bgCompaction = null;
      if (!state.busy) setStatus(docStatusText(), state.docText == null);
      renderContextGauge();
    }
  })();
  return run.done;
}

// ---------------------------------------------------------------------------
// History slimming: after a turn (and when a chat is loaded) the history keeps only what later requests
// use. Called only while no turn runs, so every message belongs to a finished turn:
//   - the provider replay payloads (_openaiItems, _anthropicBlocks) are dropped: the converters replay
//     them only for the rounds after the newest user message (the turn in progress), and the next request
//     starts with a new user message;
//   - the results of reading tools (read_document, find_in_document, get_selection,
//     also on opened documents) longer than STUB_MIN_CHARS become a short stub
//     ("[read_document lines 40–75: content omitted after the turn; re-read if needed]"; open_document keeps its
//     first line; an external lookup its digest, marked _digest: the query and what it found, so the next turn does
//     not look it up again); _omittedChars keeps the original length for the action log and _log the text itself for
//     the chat log copy (keepLogText). Compacted results keep their compaction cut;
//   - _log is dropped from the turns before the last LOG_KEEP_TURNS (pruneLogTexts), so storage stays bounded.
// Edit results, _edit journals, user messages and their _context are not touched: the requests of the
// next turns repeat the earlier turns' user messages unchanged (prompt caching). Modifies the messages in
// place; returns the number of messages changed (the caller saves the history).
// ---------------------------------------------------------------------------
function slimHistory(messages) {
  if (!Array.isArray(messages)) return 0;
  const names = toolNamesById(messages);
  let changed = 0;
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    let touched = false;
    for (const key of RAW_REPLAY_KEYS) {
      if (key in m) { delete m[key]; touched = true; }
    }
    // A compacted result is never sent again and was already shortened by the compaction.
    if (m.role === 'tool' && !m._compacted && !m._omittedChars && typeof m.content === 'string' && m.content.length > STUB_MIN_CHARS) {
      const fn = names.get(m.tool_call_id);
      if (fn && isReadingTool({ function: fn })) { // registered reading tools too
        const was = m.content.length;
        keepLogText(m, m.content);
        const stub = readingStub(fn, m.content, 'after the turn');
        // A lookup's digest (what it found): the request of a Munin turn sends only the newest ones (buildApiMessages).
        if (stub !== readingStub(fn, m.content, 'after the turn', { plain: true })) m._digest = true;
        m.content = stub;
        m._omittedChars = was;
        touched = true;
      }
    }
    if (touched) changed++;
  }
  return changed + pruneLogTexts(messages);
}

// The full text of a tool result whose content is replaced (a stub, the compaction cut), for the chat log copy only:
// never sent (apiMessage and the provider converters copy only the content) and not counted by estimateTokens. Cut at
// LOG_KEEP_CHARS. The first replacement wins: a later one only shortens the content further.
function keepLogText(m, text) {
  if (typeof m._log === 'string' || typeof text !== 'string') return;
  m._log = text.length > LOG_KEEP_CHARS ? `${text.slice(0, LOG_KEEP_CHARS)}\n${LOG_KEEP_CUT_NOTE}` : text;
}

// Drops _log from the messages before the last LOG_KEEP_TURNS turns (a turn starts with a user message that is not
// the panel's own: _auto belongs to its turn). Returns the number of messages changed.
function pruneLogTexts(messages) {
  let turns = 0;
  let from = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user' && !m._auto && ++turns === LOG_KEEP_TURNS) { from = i; break; }
  }
  if (turns < LOG_KEEP_TURNS) return 0;
  let changed = 0;
  for (let i = 0; i < from; i++) {
    const m = messages[i];
    if (m && typeof m === 'object' && '_log' in m) { delete m._log; changed++; }
  }
  return changed;
}
