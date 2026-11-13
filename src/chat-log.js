'use strict';
// Module chat-log.js: a chat as plain text for the clipboard (the copy button of a row in the chat list). Built from
// the stored history only: nothing is sent anywhere and the chat is not opened. Shift+click copies the fuller log: also
// what the model was sent (the system prompt, each turn's context, the tools offered and the token numbers), from the
// requests this panel kept in memory (keepTurnRequest). Alt+click saves the bug bundle (saveBugBundle): a JSON file with
// the stored chat, the kept requests and the document as each kept turn started, which the tool eval replays
// (development/tools/tool-eval.js --replay).
/* global accounts, addError, APPLY_MODES, sentApplyMode, askQuestionsOf, chatLabel, estimateTokens, FAILED_TURN_NOTE, fmtNum, joinSystem, locateSelection, PROVIDERS,
   readChatHistory, sentTools, state, storedWebToken, SUMMARY_PREFIX_RE */
/* exported buildBugBundle, buildChatLog, bugBundleName, copyChatLog, keepTurnRequest, keepTurnUsage, saveBugBundle, turnRequestsOf */

// Arguments longer than this (as one line of JSON) are pretty-printed over several lines.
const CHAT_LOG_ARGS_INLINE_CHARS = 200;
const CHAT_LOG_DONE_MS = 1200;
const CHAT_LOG_AGENT_STATUS = { ok: 'done', error: 'failed' }; // the rest (partial, stopped, refused …) as stored
const CHAT_LOG_INDENT = '  ';

const logLine = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
// A text indented under its call, line by line (trailing blank lines dropped).
const logIndent = (s) => String(s).replace(/\s+$/, '').split('\n').map((l) => (l ? CHAT_LOG_INDENT + l : l)).join('\n');
const pad2 = (n) => String(n).padStart(2, '0');
// Local time as "2026-10-30 14:05" (the same in every locale, so the log reads the same wherever it is pasted).
function logDate(ts) {
  if (!Number.isFinite(ts)) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// The arguments in full, as JSON without the null fields: one line when short, else pretty-printed (the lines after the
// first indented under the call). Unparsable ones as sent.
function logArgs(raw) {
  let args = null;
  try { args = JSON.parse(raw || '{}'); } catch (e) { args = null; }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return String(raw == null ? '' : raw);
  const kept = Object.fromEntries(Object.entries(args).filter(([, v]) => v != null));
  const line = JSON.stringify(kept);
  if (line.length <= CHAT_LOG_ARGS_INLINE_CHARS) return line;
  return JSON.stringify(kept, null, 2).split('\n').map((l, i) => (i ? CHAT_LOG_INDENT + l : l)).join('\n');
}

// The status word of a tool result: refused (the user did not allow it, or a check refused it), failed, undone, ok.
function logStatus(r) {
  const text = String(r.content || '');
  if (r._decision === 'rejected' || r._decision === 'stopped' || /^Refused\b/.test(text)) return 'refused';
  if (r._ok === false || /^Error:/.test(text)) return 'failed';
  if (r._edit && r._edit.undone) return 'undone';
  return 'ok';
}

// The full text of a result as the model got it during its turn: the kept text (_log) of a result replaced after its
// turn by a stub or the compaction cut, else the stored content.
const logResult = (r) => String(typeof r._log === 'string' ? r._log : r.content == null ? '' : r.content);

// A tool call: "> name({args}) → status", then the full result indented under it.
function logCall(tc, result) {
  const fn = tc.function || {};
  if (fn.name === 'ask_user' && result && result._decision) return logAsk(tc, result);
  const head = `> ${fn.name}(${logArgs(fn.arguments)})`;
  if (!result) return `${head} → no result`;
  const text = logResult(result);
  // A failure's raw text (codes, the server's words): the model and the chat got it in plain words (errorWords).
  const raw = typeof result._rawError === 'string' && result._rawError ? '\n' + logIndent(`Raw error: ${result._rawError}`) : '';
  return `${head} → ${logStatus(result)}${text.trim() ? '\n' + logIndent(text) : ''}${raw}`;
}

// An ask_user card: the status, each question on its own line with its answer (the answers come from the stored card,
// _answered), then the result text unless answered.
function logAsk(tc, result) {
  let args = {};
  try { args = JSON.parse(tc.function.arguments || '{}') || {}; } catch (e) { args = {}; }
  const questions = askQuestionsOf(args).filter((q) => q && typeof q.question === 'string');
  const a = (Array.isArray(result._answered) ? result._answered : []).find((x) => x && x.kind === 'ask') || {};
  const answers = result._decision !== 'answered' ? []
    : Array.isArray(a.questions) ? a.questions.map((q) => (q && q.answer) || '') : [a.choice || String(result._message || '').replace(/^(You chose|Chosen): ?/, '')];
  const lines = questions.map((q, i) => `  ${i + 1}. ${logLine(q.question)}${answers[i] ? ` \u2014 ${logLine(answers[i])}` : ''}`);
  const text = result._decision === 'answered' ? '' : logResult(result);
  return [`> ask_user → ${logStatus(result)}`, ...lines, ...(text.trim() ? [logIndent(text)] : [])].join('\n');
}

// An agent's report: its full answer when the record keeps it, else the message without its head line; then the
// agent's tool calls as its record keeps them (name, summary and status only: the agent's own history is not stored).
function logAgentReport(m) {
  const info = m._agent || {};
  const status = CHAT_LOG_AGENT_STATUS[info.status] || info.status || 'unknown';
  const full = typeof info.full === 'string' ? info.full.trim() : '';
  const body = full || String(m.content || '').replace(/^\[Report of agent[^\n]*\]\n?/, '').trim();
  const calls = (Array.isArray(info.log) ? info.log : []).filter((e) => e && e.name)
    .map((e) => `${CHAT_LOG_INDENT}> ${e.name}${e.summary ? ' ' + logLine(e.summary) : ''} → ${e.status || 'ok'}`);
  return `Agent ${m._agentReport.label || m._agentReport.id || ''} (${status}): ${body}${calls.length ? `\nAgent tool calls:\n${calls.join('\n')}` : ''}`;
}

// The results of an assistant message's calls by position: the tool messages that follow it, the k-th result with
// the k-th call's id (a reused id then still finds this message's own result); null where none follows.
function ownResults(list, at, calls) {
  const after = [];
  for (let i = at + 1; i < list.length && list[i] && list[i].role === 'tool'; i++) after.push(list[i]);
  return calls.map((tc, k) => {
    const nth = calls.slice(0, k).filter((c) => c.id === tc.id).length;
    return after.filter((r) => r.tool_call_id === tc.id)[nth] || null;
  });
}

// The server-side web searches of an assistant message (_toolActivity), as call-like lines, and the number of the
// round's sources (_sources) when it has any.
function logActivity(m) {
  const rows = (Array.isArray(m._toolActivity) ? m._toolActivity : []).filter(Boolean)
    .map((a) => `> ${a.name || 'web_search'} «${logLine(a.summary != null ? a.summary : a.text)}» → server`);
  const n = Array.isArray(m._sources) ? m._sources.length : 0;
  if (rows.length && n) rows.push(`${CHAT_LOG_INDENT}${n} source${n === 1 ? '' : 's'}`);
  return rows;
}
// The turn's rows the user saw (_notes, render.js addTurnRow), stored on the message that was last when they arose.
const logNotes = (m) => (Array.isArray(m._notes) ? m._notes : []).map((n) => `[row] ${logLine(n && typeof n === 'object' ? n.text : n)}`);
// What kind of automatic message (_auto) the panel sent: a continuation, a wrap-up, a nudge, a revert of the model, a failed
// turn's note.
const logAutoKind = (m) => (m._revert ? 'revert' : m._failed ? 'failed' : m._autoKind || 'continue');
// A failed turn's reason, from its note (turn.js noteFailedTurn: FAILED_TURN_NOTE with errorClause's plain words), with
// any server address in it left out (the log names no URL), or ''.
const LOG_HOST_RE = /\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/\S*)?/gi;
function failedReason(m) {
  const [pre, post] = FAILED_TURN_NOTE.split('{reason}');
  const t = String(m.content || '');
  return t.startsWith(pre) && t.endsWith(post) ? logLine(t.slice(pre.length, t.length - post.length).replace(LOG_HOST_RE, 'the server')) : '';
}
const logAutoLine = (m) => { const why = m._failed ? failedReason(m) : ''; return `[auto: ${logAutoKind(m)}]${why ? ' ' + why : ''}`; };
// The user header with the mode the message was sent with (sentApplyMode: _mode and _asks; the mode menu's name) when
// stored: "User (Manual):", "User (Auto):", "User (Plan):".
function logUserHead(m) {
  const sent = sentApplyMode(m);
  const mode = sent ? APPLY_MODES[sent] : typeof m._mode === 'string' ? m._mode : '';
  return mode ? `User (${mode}):` : 'User:';
}

// ---- What the model was sent, for the fuller log ----------------------------------------------------------------
// The first request of each chat turn (runTurn: its first round, again when that round is resent), in memory only: gone
// when the panel reloads; never stored. Per chat (docId \0 chatId) the last CHAT_LOG_REQUESTS_KEPT turns, for at most
// CHAT_LOG_REQUEST_CHATS chats (the one used longest ago dropped first). A record: { key (the turn's user message,
// logMsgKey), system (the system prompt as sent: one string shared with the previous record when equal), tools (the
// names offered), provider, model, estimated (tokens, chars/3 as the budget counts them), measured (the prompt tokens
// the provider counted for it, once known), start and doc (what the turn started from, for the bug bundle:
// keepTurnStart) }. No key, header, URL or account id is kept.
const CHAT_LOG_REQUESTS_KEPT = 30;
const CHAT_LOG_REQUEST_CHATS = 10; // a Munin persona turn's prompt carries up to 30,000 characters of the document
const turnRequests = new Map();
const CHAT_LOG_NOT_KEPT = `Request: not available (the panel keeps the requests of the last ${CHAT_LOG_REQUESTS_KEPT} turns of a chat since it was opened).`;
// A user message's key: a hash of its text and turn context (the same message read back from storage gives the same key).
function logMsgKey(m) {
  const s = `${(m && m.content) || ''}\u0000${(m && m._context) || ''}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36) + ':' + s.length;
}
// Keeps (or, for the same turn's resend, updates: rec) the turn's first request; returns its record.
function keepTurnRequest(chatCtx, userMsg, req, snap, rec = null) {
  if (!chatCtx || !chatCtx.chatId || !userMsg || !req || !snap || !snap.prov) return rec;
  const id = `${chatCtx.docId || ''}\u0000${chatCtx.chatId}`;
  const list = turnRequests.get(id) || [];
  turnRequests.delete(id); // the chat moves to the end: the one used longest ago goes first
  turnRequests.set(id, list);
  while (turnRequests.size > CHAT_LOG_REQUEST_CHATS) turnRequests.delete(turnRequests.keys().next().value);
  const r = rec && list.includes(rec) ? rec : { key: logMsgKey(userMsg), measured: null };
  const tools = Array.isArray(req.tools) ? req.tools : [];
  const text = req.system ? joinSystem(req.system) : '';
  const prev = list[list.indexOf(r) >= 0 ? list.indexOf(r) - 1 : list.length - 1];
  Object.assign(r, {
    system: prev && prev.system === text ? prev.system : text,
    tools: tools.map((t) => t && t.function && t.function.name).filter(Boolean),
    provider: snap.prov.label || snap.prov.id || '', model: (snap.cfg && snap.cfg.model) || '',
    estimated: estimateTokens(Array.isArray(req.messages) ? req.messages : [], tools.length ? JSON.stringify(sentTools(tools, snap.prov)).length : 0),
  });
  if (!list.includes(r)) {
    list.push(r);
    if (list.length > CHAT_LOG_REQUESTS_KEPT) list.splice(0, list.length - CHAT_LOG_REQUESTS_KEPT);
  }
  keepTurnStart(r, userMsg, snap);
  return r;
}
// The prompt tokens the provider counted for the turn's first request (its first response's usage).
function keepTurnUsage(rec, usage) {
  const n = usage ? Number(usage.prompt_tokens) : NaN;
  if (rec && Number.isFinite(n) && n > 0) rec.measured = n;
}
// The kept requests of a chat, oldest first, or [].
const turnRequestsOf = (docId, chatId) => (turnRequests.get(`${docId || ''}\u0000${chatId}`) || []).slice();

// A user message that starts a turn: the user's own, or an agents' report sent as the turn's message (it has a context).
const logTurnStart = (m) => m.role === 'user' && !m._summary && (!m._auto || (!!m._agentReport && typeof m._context === 'string'));
// The kept request of each turn: Map message -> record, matched in order by logMsgKey (a repeated message takes the next).
function matchRequests(list, requests) {
  const out = new Map();
  let from = 0;
  for (const m of list) {
    if (!m || !logTurnStart(m)) continue;
    const key = logMsgKey(m);
    const at = requests.findIndex((r, i) => i >= from && r.key === key);
    if (at >= 0) { out.set(m, requests[at]); from = at + 1; }
  }
  return out;
}
// The changed lines of the system prompt: the old ones "- …", the new ones "+ …" (the common start and end left out).
function logSystemChange(prev, next) {
  const a = prev.split('\n');
  const b = next.split('\n');
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  const mark = (sign) => (l) => (l ? `${sign} ${l}` : sign);
  return [...a.slice(p, a.length - q).map(mark('-')), ...b.slice(p, b.length - q).map(mark('+'))];
}
// The lines a turn's user block gets in the fuller log: its context, its request (or that it is not kept) and the change
// of the system prompt since the turn before that has one.
function logTurnRequest(m, rec, prev) {
  const ctx = typeof m._context === 'string' && m._context.trim() ? [`Context:\n${logIndent(m._context)}`] : [];
  if (!rec) return [...ctx, CHAT_LOG_NOT_KEPT];
  const tokens = `about ${fmtNum(rec.estimated)} tokens estimated${rec.measured ? `, ${fmtNum(rec.measured)} measured` : ''}`;
  const lines = [...ctx, `Request: ${[rec.provider, rec.model, tokens].filter(Boolean).join(' · ')}`, `Tools: ${rec.tools.length ? rec.tools.join(', ') : 'none'}`];
  if (prev && prev.system !== rec.system) lines.push(`System prompt changed:\n${logIndent(logSystemChange(prev.system, rec.system).join('\n'))}`);
  return lines;
}

// The chat as text: a header line, then one block per message (a turn's rounds are one Assistant block, as the chat shows
// one bubble per turn), a blank line between them. The panel's own requests (_auto: continuations, wrap-ups, nudges) are
// one "[auto: kind]" line in their turn, a failed turn's with its reason (an agent's report is kept whole); the turn's rows are "[row] …" lines; the
// server-side web searches are call-like lines. Left out: the per-turn context (_context) and reasoning.
// meta: { title, docTitle, model, provider (its account's type: "Custom"), at }. requests (the fuller log: the chat's kept
// requests, turnRequestsOf): after the header the system prompt of the first kept turn, and under each turn's user message
// its context and request (logTurnRequest); null: the plain log.
function buildChatLog(messages, meta = {}, requests = null) {
  const model = meta.model && meta.provider ? `${meta.model} (${meta.provider})` : meta.model || meta.provider;
  const head = ['Chat: ' + (meta.title || 'New chat'), meta.docTitle, model, logDate(meta.at)].filter(Boolean).join(' · ');
  const list = Array.isArray(messages) ? messages : [];
  const results = new Map();
  const counts = new Map(); // tool_call_id -> how many results carry it (more than one: a server reused the id)
  for (const m of list) {
    if (!m || m.role !== 'tool') continue;
    results.set(m.tool_call_id, m);
    counts.set(m.tool_call_id, (counts.get(m.tool_call_id) || 0) + 1);
  }
  const blocks = [head];
  const sent = Array.isArray(requests) ? matchRequests(list, requests) : null;
  let prevSent = null; // the kept request of the turn before (its system prompt)
  if (sent) {
    const first = [...sent.values()][0];
    blocks.push(first ? `System prompt:\n${logIndent(first.system || '(none)')}` : CHAT_LOG_NOT_KEPT.replace(/^Request:/, 'System prompt:'));
  }
  let turn = -1; // the index of this turn's Assistant block: a turn is one message, its rounds one block (as shown)
  // Lines that belong to the turn: into its Assistant block, else after the last block (a user message, an auto line).
  const addLines = (lines) => { if (lines.length) blocks[turn >= 0 ? turn : blocks.length - 1] += `\n${lines.join('\n')}`; };
  for (const [at, m] of list.entries()) {
    if (!m) continue;
    if (m.role === 'user') {
      if (!m._auto || m._agentReport || m._summary) turn = -1;
      if (m._agentReport) blocks.push(logAgentReport(m));
      else if (m._summary) blocks.push(`Summary:\n${String(m.content || '').replace(SUMMARY_PREFIX_RE, '').trim()}`);
      else if (!m._auto) blocks.push(`${logUserHead(m)}\n${String(m.content || '').trim()}`);
      else addLines([logAutoLine(m)]);
      if (sent && logTurnStart(m)) {
        const rec = sent.get(m) || null;
        addLines(logTurnRequest(m, rec, prevSent));
        if (rec) prevSent = rec;
      }
      if (!m._summary) addLines(logNotes(m));
    } else if (m.role === 'assistant') {
      const lines = logActivity(m);
      const text = String(m.content || '').trim();
      if (text) lines.push(text);
      const own = ownResults(list, at, m.tool_calls || []);
      for (const [k, tc] of (m.tool_calls || []).entries()) lines.push(logCall(tc, counts.get(tc.id) > 1 ? own[k] : results.get(tc.id)));
      if (lines.length) {
        if (turn >= 0) blocks[turn] += `\n${lines.join('\n')}`;
        else turn = blocks.push(`Assistant:\n${lines.join('\n')}`) - 1;
      }
      addLines(logNotes(m));
    } else if (m.role === 'tool') addLines(logNotes(m));
  }
  return blocks.join('\n\n') + '\n';
}

// The model the chat runs on and its account's id: its stored choice, else the one named by its last user message
// ("<account>/<model>").
function logChoice(meta, messages) {
  if (meta && meta.model && meta.model.model) return { model: meta.model.model, account: meta.model.accountId || '' };
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const tag = m && m.role === 'user' && typeof m._model === 'string' ? m._model : '';
    if (tag) return { model: tag.slice(tag.indexOf('/') + 1), account: tag.slice(0, Math.max(0, tag.indexOf('/'))) };
  }
  return { model: '', account: '' };
}
const logModel = (meta, messages) => logChoice(meta, messages).model;
// The type of that account ("Munin", "Custom"), never its id or name; '' when the account is gone.
function logProviderType(meta, messages) {
  const id = logChoice(meta, messages).account;
  const a = id ? accounts().find((x) => x && x.id === id) : null;
  const type = a ? a.type : id; // a tag without an account names the type itself (request.js runAsTag)
  return PROVIDERS[type] ? PROVIDERS[type].name || type : '';
}

// Writes the text to the clipboard: the async API, else a hidden textarea and execCommand (works where the API is
// refused, e.g. without the panel's focus). Returns whether it was copied.
async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) { /* the fallback below */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
  document.body.appendChild(ta);
  try {
    ta.select();
    return typeof document.execCommand === 'function' && document.execCommand('copy') === true;
  } catch (e) {
    return false;
  } finally {
    ta.remove();
  }
}

// The copy button of a chat row: reads that chat's stored history (the open chat: the panel's own copy) and copies its
// log; the button shows the check mark for a moment. The chat is not opened. full (Shift+click): the fuller log, with
// what the model was sent (buildChatLog's requests).
async function copyChatLog(chatId, btn, { full = false } = {}) {
  const docId = state.docId;
  const meta = state.chats.find((c) => c.id === chatId);
  if (!docId || !meta) return false;
  const messages = chatId === state.chatId ? state.messages : await readChatHistory(docId, chatId);
  const text = buildChatLog(messages, { title: chatLabel(meta), docTitle: state.docTitle, model: logModel(meta, messages), provider: logProviderType(meta, messages), at: meta.updatedAt },
    full ? turnRequestsOf(docId, chatId) : null);
  if (!(await writeClipboard(text))) { addError('Could not copy the chat log. Click the copy button again.'); return false; }
  if (btn) { btn.classList.add('done'); setTimeout(() => btn.classList.remove('done'), CHAT_LOG_DONE_MS); }
  return true;
}

// ---- The bug bundle (Alt+click on a chat's copy button) -------------------------------------------------------------
// What a kept turn started from (keepTurnRequest, on the turn's first request): rec.start = { mode (the mode the message
// was sent with: 'manual' (Manual: an editing turn that asks before each write; in bundles of earlier builds a read-only
// Manual turn) | 'edit' (Auto) | 'plan', or '/<persona>'), selection: { text, lines: [first, last] | null }, docInstructions,
// mainInstructions, files: [{ alias, title, kind: 'file' | 'document' }] (the document's files and the documents opened in
// the chat: names only), providerType } and rec.doc, the document the turn's snapshot was built from: { format:
// 'docs-api', tabId, json (the documents.get body as returned, as JSON text: compact, and safe from later changes) } or
// { format: 'markdown' | 'text', text (the export) }, or null. A document equal to the latest kept one (of any chat) is
// that same object, kept once. In memory only, bounded with the records and in all by CHAT_LOG_DOC_CHARS (a long
// session of edits keeps one version per turn): past it the documents used longest ago go, their turns marked docDropped.
const CHAT_LOG_DOC_CHARS = 20000000;
let lastKeptDoc = null;
const keptDocText = (d) => (d.format === 'docs-api' ? d.json : d.text) || '';
const sameKeptDoc = (a, b) => a.format === b.format && (a.tabId || null) === (b.tabId || null) && keptDocText(a) === keptDocText(b);
function keepTurnStart(r, userMsg, snap) {
  if (r.start) return; // a resend of the turn's first request: the same start
  const view = snap.promptView || snap;
  const raw = view.model && view.model.raw; // docs-model.js fetchDocModel
  let doc = null;
  if (view.docFormat === 'docs-api') doc = raw ? { format: 'docs-api', tabId: view.model.tabId || null, json: JSON.stringify(raw) } : null;
  else if (typeof view.docText === 'string') doc = { format: view.docFormat === 'markdown' ? 'markdown' : 'text', text: view.docText };
  if (doc && lastKeptDoc && sameKeptDoc(doc, lastKeptDoc)) doc = lastKeptDoc;
  if (doc) lastKeptDoc = doc;
  r.doc = doc;
  let span = null;
  try { span = view.selection ? locateSelection({ ...view, lines: null }) : null; } catch (e) { span = null; }
  r.start = {
    mode: userMsg._persona ? `/${userMsg._persona}` : userMsg._asks ? 'manual' : userMsg._mode || '',
    selection: { text: view.selection || '', lines: span ? [span.start, span.end] : null },
    docInstructions: snap.docInstructions || '', mainInstructions: snap.mainInstructions || '',
    files: (Array.isArray(view.docs) ? view.docs : []).filter(Boolean)
      .map((d) => ({ alias: d.alias || '', title: d.title || '', kind: d.kind === 'file' ? 'file' : 'document' })),
    providerType: (snap.prov && snap.prov.id) || '',
  };
  trimKeptDocs();
}
// Past CHAT_LOG_DOC_CHARS of kept documents, the ones whose latest turn is oldest (chats used longest ago first) go.
function trimKeptDocs() {
  const latest = new Map(); // document -> the position of the latest record that has it
  let i = 0;
  for (const list of turnRequests.values()) for (const r of list) { if (r.doc) latest.set(r.doc, i); i++; }
  let total = 0;
  for (const d of latest.keys()) total += keptDocText(d).length;
  for (const [d] of [...latest.entries()].sort((a, b) => a[1] - b[1])) {
    if (total <= CHAT_LOG_DOC_CHARS) break;
    for (const list of turnRequests.values()) for (const r of list) if (r.doc === d) { r.doc = null; r.docDropped = true; }
    if (lastKeptDoc === d) lastKeptDoc = null;
    total -= keptDocText(d).length;
  }
}

// The bug bundle of a chat (saveBugBundle; read by test/lib/tool-eval.js replay): { kind, version, app (the extension's
// version), savedAt, chat: { title, docTitle, model, updatedAt }, messages (the stored history as it is), systems (the
// distinct system prompts), documents (the distinct documents: { format: 'docs-api', tabId, body } | { format, text }),
// turns: one per turn of the chat (logTurnStart), oldest first: { message (the index of its user message), kept } and,
// for a kept turn, its request (provider, providerType, model, system (an index of systems), tools, estimated,
// measured), its start (keepTurnStart: mode, selection, docInstructions, mainInstructions, files) and document (an index
// of documents, or null with documentNote) }. secrets: strings to remove; image content links go too (redactBundle).
const BUG_BUNDLE_KIND = 'munin-bug-bundle';
const BUG_BUNDLE_VERSION = 1;
const BUG_BUNDLE_NOT_KEPT = `Not kept: the panel keeps the last ${CHAT_LOG_REQUESTS_KEPT} turns of a chat since it was opened.`;
function buildBugBundle(messages, meta = {}, requests = [], { app = '', secrets = [], now = Date.now() } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const sent = matchRequests(list, Array.isArray(requests) ? requests : []);
  const systems = [];
  const documents = [];
  const docAt = new Map();
  const turns = [];
  list.forEach((m, at) => {
    if (!m || !logTurnStart(m)) return;
    const rec = sent.get(m);
    if (!rec) { turns.push({ message: at, kept: false, note: BUG_BUNDLE_NOT_KEPT }); return; }
    if (!systems.includes(rec.system)) systems.push(rec.system);
    if (rec.doc && !docAt.has(rec.doc)) docAt.set(rec.doc, documents.push(bundleDocument(rec.doc)) - 1);
    const { providerType = '', ...start } = rec.start || {};
    const document = rec.doc ? docAt.get(rec.doc) : null;
    turns.push({
      message: at, kept: true, provider: rec.provider, providerType, model: rec.model, system: systems.indexOf(rec.system), tools: rec.tools.slice(),
      estimated: rec.estimated, measured: rec.measured, ...start, document,
      ...(document == null ? { documentNote: rec.docDropped ? 'No longer in memory (the panel keeps a bounded number of document versions).' : 'The turn had no document.' } : {}),
    });
  });
  return redactBundle({
    kind: BUG_BUNDLE_KIND, version: BUG_BUNDLE_VERSION, app, savedAt: new Date(now).toISOString(),
    chat: { title: meta.title || '', docTitle: meta.docTitle || '', model: meta.model || '', updatedAt: Number.isFinite(meta.at) ? meta.at : null },
    messages: list, systems, documents, turns,
  }, secrets);
}
const bundleDocument = (d) => (d.format === 'docs-api' ? { format: d.format, tabId: d.tabId, body: JSON.parse(d.json) } : { format: d.format, text: d.text });
// A copy of the bundle without the secrets (strings of 6 or more characters, wherever they occur) and without image
// content links: a documents.get contentUri and any googleusercontent.com address open the image without a login. The
// API's contentUri is on docs.google.com (an images path such as /docs-images-rt/…; real-docs.js fact 6); a document's
// own link (/document/d/…) is not an image link and stays.
const BUNDLE_IMAGE_LINK_RE = /https?:\/\/(?:[a-z0-9.-]*googleusercontent\.com\/|docs\.google\.com\/(?:u\/\d+\/)?[\w-]*images[\w-]*\/)[^\s"'<>)\]]*/gi;
const BUNDLE_REDACTED = '[redacted]';
function redactBundle(value, secrets) {
  const list = [...new Set((secrets || []).filter((s) => typeof s === 'string' && s.length >= 6))].sort((a, b) => b.length - a.length);
  const clean = (s) => list.reduce((t, x) => (t.includes(x) ? t.split(x).join(BUNDLE_REDACTED) : t), s.replace(BUNDLE_IMAGE_LINK_RE, BUNDLE_REDACTED));
  const walk = (v) => {
    if (typeof v === 'string') return clean(v);
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object') return v;
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = k === 'contentUri' ? BUNDLE_REDACTED : walk(x);
    return out;
  };
  return walk(value);
}
// The strings a bundle must not contain: every account's key, server URL and id (not one named after its type, as a
// migrated account is: "munin"), the settings' other keys and tokens, the Google token.
async function bundleSecrets() {
  const out = [];
  for (const a of accounts()) if (a) out.push(PROVIDERS[a.id] ? '' : a.id, a.apiKey, a.baseUrl);
  const s = state.settings || {};
  for (const p of Object.values(s.providers || {})) if (p && typeof p === 'object') out.push(p.apiKey, p.baseUrl);
  for (const [k, v] of Object.entries(s)) if (/key|token|secret|password/i.test(k)) out.push(v);
  try { const t = await storedWebToken(); if (t) out.push(t.token); } catch (e) { /* no token */ }
  return out.filter((x) => typeof x === 'string' && x.length >= 6);
}
// "munin-bug-<title slug>-<date>.json" (the slug keeps letters of any script).
function bugBundleName(title, ts = Date.now()) {
  const slug = String(title || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+/, '').slice(0, 40).replace(/-+$/, '') || 'chat';
  const d = new Date(ts);
  return `munin-bug-${slug}-${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}.json`;
}
// Saves text as a download: a Blob link clicked in the panel (no downloads permission; the click's user activation lets
// the panel's frame download). The link's address is released a while later (released at once, a download can fail).
const BUG_BUNDLE_URL_MS = 60000;
function downloadText(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.appendChild(a);
  try { a.click(); } finally {
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), BUG_BUNDLE_URL_MS);
  }
}
const extensionVersion = () => { try { return chrome.runtime.getManifest().version || ''; } catch (e) { return ''; } };

// The copy button's Alt+click: the chat's bug bundle as a download (bugBundleName), from its stored history (the open
// chat: the panel's own copy) and what this panel kept of its turns; the button shows the check mark for a moment.
async function saveBugBundle(chatId, btn) {
  const docId = state.docId;
  const meta = state.chats.find((c) => c.id === chatId);
  if (!docId || !meta) return false;
  try {
    const messages = chatId === state.chatId ? state.messages : await readChatHistory(docId, chatId);
    const title = chatLabel(meta);
    const bundle = buildBugBundle(messages, { title, docTitle: state.docTitle, model: logModel(meta, messages), at: meta.updatedAt },
      turnRequestsOf(docId, chatId), { app: extensionVersion(), secrets: await bundleSecrets() });
    downloadText(bugBundleName(title), JSON.stringify(bundle), 'application/json');
  } catch (e) {
    console.warn('Munin: the bug bundle failed:', e);
    addError('Could not save the bug bundle. Alt+click the copy button again.');
    return false;
  }
  if (btn) { btn.classList.add('done'); setTimeout(() => btn.classList.remove('done'), CHAT_LOG_DONE_MS); }
  return true;
}
