'use strict';
// Module render.js: chat rendering: bubbles, notices, errors, tool cards, the action-log rows
// (renderActivity), the Manual-mode edit blocks (parseEditBlock), the /side bubbles (syncSideThread), the thinking
// orb's mode and place (orbModeFor, syncOrb, the frozen frame of a stopped or failed turn), the location line of a
// running read or write (placeText), the "What changed" fold of an applied replacement (editDiff, word-diff.js),
// renderHistory and the context gauge (renderContextGauge).
/* global $, actionButtons, appendToChat, actionLogFromToolCalls, activeConfig, activeHistory, activeProvider, answerEdits, AUTO_CONTINUE_NOTICE,
   ASK_USER_TOOL, compactionBudget, docLines, docOutline, EDIT_TOOL_ICONS, editCards, el, escapeHtml, estimateTokens, extraIcon, extraTool, fmtNum,
   isMainDocRef,
   FOLD_NOTE, GAUGE_WARN_RATIO, isReadingTool, lastUserIndex, latestUndoable, LOG_MAX_CHARS, NOTICE_TTL_MS,
   openSettings, orbCreate, orbSetState, pendingPreviews, PERSONAS, READING_TOOL_ICONS, renderMarkdown, renderSources,
   REPLACE_TOOL, requestTokens, scrollToBottom, snapshotDocument, state, SUMMARY_PREFIX, wordDiff, wordDiffHtml, WRITE_TOOLS,
   ZOTERO_TOKEN_RE, applyTurnMode */
/* exported addNotice, addError, addUserBubble, addAssistantBubble, activitySummary, updateAssistantBubble,
   toolCard, toolCardFor, pendingCardText, REMEMBER_PENDING, isEditTool, renderEmpty, parseToolArgs, renderHistoryKeepingNotices,
   renderHistory, renderContextGauge, syncSideThread, forgetSideBubbles, lastSentText, placeText, headingAbove, editDiff */

// ---------------------------------------------------------------------------
// Chat rendering
// ---------------------------------------------------------------------------
function addBubble(cls, html) {
  const d = document.createElement('div');
  d.className = 'msg ' + cls;
  d.innerHTML = html;
  return appendToChat(d);
}
// Notices are transient: they fade out after NOTICE_TTL_MS unless { sticky: true } (outcomes the user
// must not miss). Errors always stay. renderHistory() drops every notice anyway (they are not stored).
function addNotice(t, { sticky = false } = {}) {
  const b = addBubble('notice', escapeHtml(t));
  if (!sticky) dismissLater(b);
  if (/^Stopped\./.test(String(t))) freezeTurnOrb(b); // the end of a stopped turn
  return b;
}

function dismissLater(b, ms = NOTICE_TTL_MS) {
  setTimeout(() => {
    if (!b.isConnected) return;
    b.classList.add('fading');
    const remove = () => { if (b.isConnected) b.remove(); };
    b.addEventListener('transitionend', remove, { once: true });
    setTimeout(remove, 600); // in case transitions are disabled
  }, ms);
}
function addError(t, withSettingsButton) {
  const b = addBubble('error', escapeHtml(t));
  if (withSettingsButton) {
    b.classList.add('settings-error'); // removed by clearSettingsErrors() once settings are saved
    const btn = document.createElement('button');
    btn.className = 'btn small'; btn.textContent = 'Open settings';
    btn.style.marginLeft = '6px';
    btn.addEventListener('click', openSettings);
    b.appendChild(btn);
  }
  freezeTurnOrb(b); // a turn that failed (no-op outside a turn)
  return b;
}

// ---- The /side thread ---------------------------------------------------------------------------
// The bubbles of side turns (state.sideTurn) carry a "Side" badge and a tint. They are not in the history, so
// renderHistory puts the ones in sideBubbles back at the end: a side exchange stays visible until the next
// main turn ends (runTurn calls forgetSideBubbles at its start) or the chat changes (syncSideThread).
const sideBubbles = [];
function markSide(d) {
  if (!state.sideTurn) return;
  d.classList.add('side');
  const badge = document.createElement('span');
  badge.className = 'side-badge';
  badge.textContent = 'Side';
  badge.title = 'Side question: not saved, not sent with later messages';
  d.appendChild(badge);
  sideBubbles.push(d);
}
const forgetSideBubbles = () => { sideBubbles.length = 0; };
// The side thread belongs to one chat of one document: on another chat (switch, new chat, other document,
// reload) it starts empty.
function syncSideThread() {
  const key = `${state.docId}:${state.chatId}`;
  if (state.sideKey === key) return;
  state.sideKey = key;
  state.sideMessages = [];
  forgetSideBubbles();
}

// The bubble of the message a turn sends (runTurn, runSideTurn); renderHistory draws stored ones with userBubble.
// Its text is kept for the beforeTurn hooks (lastSentText: references.js reads the Zotero picks in it), and the turn's
// orb starts over.
let sentText = '';
const lastSentText = () => sentText;
function addUserBubble(text, persona) {
  sentText = String(text || '');
  turnOrb = null;
  return userBubble(text, persona);
}
// persona: set for slash-command turns ("research" | "code" | "chat"); shows a small badge.
function userBubble(text, persona) {
  const d = addBubble('user', '');
  markSide(d);
  const p = persona && PERSONAS[persona];
  if (p) {
    const badge = document.createElement('span');
    badge.className = 'persona-badge';
    badge.textContent = `${p.emoji} ${persona}`;
    badge.title = `Sent with /${persona}`;
    d.appendChild(badge);
  }
  appendWithChips(d, String(text));
  return d;
}
// The message text, its Zotero picks ("@[Smith 2020: Title…](zotero:KEY)", references.js) shown as chips.
function appendWithChips(d, text) {
  let last = 0;
  for (const m of text.matchAll(ZOTERO_TOKEN_RE)) {
    if (m.index > last) d.appendChild(document.createTextNode(text.slice(last, m.index)));
    const chip = document.createElement('span');
    chip.className = 'zotero-chip';
    chip.textContent = m[1];
    chip.title = `Zotero item ${m[2].toUpperCase()}`;
    d.appendChild(chip);
    last = m.index + m[0].length;
  }
  if (last < text.length) d.appendChild(document.createTextNode(text.slice(last)));
}

// Assistant bubble: [Thinking (collapsible)] [markdown answer] [Apply/Copy] [token usage].
// Child nodes are created once and updated in place, so the Thinking open/closed state survives streaming.
function addAssistantBubble() {
  const b = addBubble('assistant', '');
  markSide(b);
  const think = document.createElement('details');
  think.className = 'thinking hidden';
  const sum = document.createElement('summary');
  const label = document.createElement('span'); // the orb, when it shows, goes before it (in place of the marker)
  label.className = 'thinking-label';
  label.textContent = 'Thinking';
  sum.appendChild(label);
  const body = document.createElement('div');
  body.className = 'thinking-body';
  think.append(sum, body);
  const activity = document.createElement('div');
  activity.className = 'activity hidden';
  const md = document.createElement('div');
  md.className = 'md';
  const actions = document.createElement('div');
  actions.className = 'msg-actions hidden';
  actions.innerHTML = actionButtons('apply-msg', 'copy-msg');
  const meta = document.createElement('div');
  meta.className = 'msg-meta hidden';
  const place = document.createElement('div'); // where a running read or write is (placeText)
  place.className = 'agent-place hidden';
  b.append(think, activity, md, place, actions, meta);
  b._parts = { think, sum, label, body, activity, md, place, actions, meta };
  b._rows = []; // activity rows (see renderActivity)
  b._text = '';
  b._codes = [];
  b._blockIdx = null; // index in _codes of the answer's edit block (parseEditBlock), or null
  b._orb = null; // the thinking orb (orb.js), created by the first live update that needs it
  b._orbMode = null;
  return b;
}

// ---- The thinking orb (orb.js) -------------------------------------------------------------------
// Its mode for the bubble's state. A tool call of this panel still running: its kind (toolOrbMode: a search ->
// globe, a write -> rubik, its verifying re-read (the row's phase 'verifying') -> ring, anything else -> orbits).
// The re-read gets the ring, not a later moment of the rubik: a rubik cycle takes seconds (its bands click back into
// place only in its second half), a re-read well under one, so a rubik restarted for it would show only scrambling.
// Otherwise only while the reply streams: text -> ribbon; before the text, whatever arrived last: a server-side tool
// row (web search: globe, a Munin persona tool: by its name) or reasoning / nothing yet -> ring. A finished, stopped
// or failed reply -> null. Over all of them: while a card waits on the user (ask_user, the edit gate, open_document)
// -> wave (listening).
const ORB_SEARCH_RE = /search|find|scholar|openalex|arxiv|pubmed|literature/i;
function toolOrbMode(name, phase) {
  if (phase === 'verifying') return 'ring';
  const n = String(name || '');
  if (ORB_SEARCH_RE.test(n) && n !== 'find_reference') return 'globe';
  if (n === ASK_USER_TOOL.function.name || n === 'remember') return 'orbits';
  return isEditTool(n) ? 'rubik' : 'orbits';
}
function orbBaseMode(b, text, reasoning, streaming, list) {
  const pending = list.filter((a) => a && a.log && a.status === 'pending');
  if (pending.length) return toolOrbMode(pending[pending.length - 1].name, pending[pending.length - 1].phase);
  if (!streaming) return null;
  if (text) return 'ribbon';
  const acts = b._orbActs || 0, thought = b._orbThought || 0;
  b._orbActs = list.length;
  b._orbThought = reasoning.length;
  if (list.length > acts) return toolOrbMode(list[list.length - 1] && list[list.length - 1].name);
  if (reasoning.length > thought) return 'ring';
  return b._orbBase || 'ring';
}
// A permission, question or Your-turn card waits for a click (gate.js).
const waitingOnUser = () => [...pendingPreviews.values()].some((p) => p && p.card && p.card.isConnected);
function orbModeFor(b, text, reasoning, streaming, list) {
  const base = orbBaseMode(b, text, reasoning, streaming, list);
  b._orbBase = base;
  return base && waitingOnUser() ? 'wave' : base;
}

// Where the orb sits: in place of the Thinking section's disclosure marker while that section shows, else at the
// bubble's status line (before its buttons).
function placeOrb(b) {
  const p = b._parts;
  const inSummary = !p.think.classList.contains('hidden');
  if (inSummary) { if (b._orb.parentNode !== p.sum) p.sum.insertBefore(b._orb, p.label); } else if (b._orb.parentNode !== b) b.insertBefore(b._orb, p.place);
}
// Idempotent (the render tick runs often): the canvas is made once per bubble, only when a mode is needed (a
// bubble rendered from the history never gets one); a bubble that leaves the page stops its loop (orb.js).
let liveOrbBubble = null; // the bubble whose orb follows the stream (refreshLiveOrb)
let turnOrb = null; // the last live mode of this turn's orb: the frozen frame after Stop or an error
function syncOrb(b, mode) {
  if (!state.busy) turnOrb = null; // an idle panel keeps no live mode (the frozen frame is drawn while busy)
  if (b._orb) placeOrb(b);
  if (mode) { liveOrbBubble = b; turnOrb = mode === 'wave' ? turnOrb || 'ring' : mode; watchChat(); }
  if (b._orbMode === mode) return;
  b._orbMode = mode;
  if (!b._orb) {
    if (!mode) return;
    b._orb = orbCreate();
    placeOrb(b);
  }
  orbSetState(b._orb, mode);
}

// The cards that wait on the user appear and go without a render of the bubble: the chat is watched, so the live orb
// switches to the wave and back, and a Your-turn card of the self-test (no live bubble) gets a listening orb of its own.
let chatWatch = null;
function watchChat() {
  if (chatWatch || typeof MutationObserver !== 'function' || !el.chat) return;
  chatWatch = new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes || []) if (n && n.classList && n.classList.contains('your-turn')) cardOrb(n);
    refreshLiveOrb();
  });
  chatWatch.observe(el.chat, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
}
function refreshLiveOrb() {
  const b = liveOrbBubble;
  if (!b || !b.isConnected || !b._orbBase) return;
  syncOrb(b, waitingOnUser() ? 'wave' : b._orbBase);
}
function cardOrb(card) {
  if (card.querySelector('canvas.orb')) return;
  const head = card.querySelector('.pv-head');
  if (!head) return;
  const c = orbCreate();
  head.insertBefore(c, head.firstChild);
  orbSetState(c, 'wave');
}

// After Stop or an error inside a turn (addNotice "Stopped.", addError while busy): the orb's last mode stays as one
// still frame, in the turn's last answer bubble (after the final re-render) or, when the turn has none, in the notice.
function freezeTurnOrb(notice) {
  if (!state.busy || !turnOrb) return;
  const mode = turnOrb;
  turnOrb = null;
  liveOrbBubble = null;
  const all = [...el.chat.querySelectorAll('.msg.user, .msg.assistant')];
  const last = all[all.length - 1];
  const b = last && last.classList.contains('assistant') && last._parts ? last : null;
  const c = b ? b._orb || (b._orb = orbCreate()) : orbCreate();
  if (b) { b._orbMode = null; b._orbBase = null; placeOrb(b); } else notice.insertBefore(c, notice.firstChild);
  orbSetState(c, mode, { frozen: true });
}

// ---- Where the agent works: the location line under the live bubble ------------------------------------------
// "Writing in Methods, line 42", "Reading lines 12–40 in Results": from the running call's tool and arguments and the
// nearest heading above that line in the outline of the panel's document (read-only; the turn snapshot is frozen
// from the same state). Text only: there is no message to scroll the Docs tab to a line.
let outlineCache = { text: null, model: null, items: [] };
function panelOutline() {
  if (outlineCache.text !== state.docText || outlineCache.model !== state.docModel) {
    let items = [];
    try { items = docOutline({ docText: state.docText, docFormat: state.docFormat, model: state.docFormat === 'docs-api' ? state.docModel : null }); } catch (e) { items = []; }
    outlineCache = { text: state.docText, model: state.docModel, items };
  }
  return outlineCache.items;
}
// The title of the nearest heading at or above line n, or ''.
function headingAbove(n, items = panelOutline()) {
  let best = '';
  for (const h of items) if (h.line <= n) best = h.title; else break;
  return best;
}
// The first line whose text holds the start of s (replace_text, format_text), or 0.
function lineOfText(s) {
  const first = String(s || '').split('\n').map((l) => l.trim()).find(Boolean);
  if (!first) return 0;
  const probe = first.slice(0, 60);
  const lines = state.docFormat === 'docs-api' && state.docModel ? state.docModel.lines.map((l) => l.text)
    : state.docText != null ? docLines({ docText: state.docText }) : [];
  const i = lines.findIndex((l) => String(l).includes(probe));
  return i < 0 ? 0 : i + 1;
}
const rangeText = (a, b) => (Number(a) === Number(b) || b == null ? `line ${a}` : `lines ${a}–${b}`);
// The location line of a running call (a log entry: name, args, phase), or ''. While a write's re-read verifies it
// (phase 'verifying'): "Verifying the edit in Methods" (the heading of the write), else "Verifying the edit".
function placeText(a) {
  if (!a || !a.args || typeof a.args !== 'object') return '';
  if (a.phase === 'verifying') return verifyingText(a);
  return writingText(a);
}
const VERIFYING = 'Verifying the edit';
function verifyingText(a) {
  const { name, args } = a;
  const h = (n) => (n > 0 && isMainDocRef(args.doc) ? headingAbove(n) : '');
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const heading = name === 'replace_section' && typeof args.heading === 'string' ? oneLineClip(args.heading)
    : name === 'insert_after_line' ? h(num(args.line))
    : name === 'delete_lines' || name === 'format_lines' ? h(num(args.start))
    : name === 'replace_text' || name === 'format_text' ? h(lineOfText(args.old_text)) : '';
  return heading ? `${VERIFYING} in ${heading}` : VERIFYING;
}
function writingText(a) {
  const { name, args } = a;
  const other = !isMainDocRef(args.doc);
  const at = (line, verb, where) => {
    const h = line > 0 && !other ? headingAbove(line) : '';
    return `${verb}${h ? ` in ${h}` : ''}${where ? (h ? ', ' : ' ') + where : ''}`;
  };
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  switch (name) {
    case 'read_lines': return `Reading ${rangeText(args.start, args.end)}${other ? ' of another document' : (headingAbove(num(args.start)) ? ` in ${headingAbove(num(args.start))}` : '')}`;
    case 'read_formatting': return `Reading the formatting of ${rangeText(args.start, args.end)}${other ? ' of another document' : ''}`;
    case 'find_in_document': return typeof args.query === 'string' ? `Searching ${other ? 'another document' : 'the document'} for "${oneLineClip(args.query)}"` : '';
    case 'get_outline': return other ? 'Reading the outline of another document' : 'Reading the outline';
    case 'insert_after_line': return num(args.line) === 0 ? 'Writing at the beginning' : at(num(args.line), 'Writing', `after line ${num(args.line)}`);
    case 'delete_lines': return at(num(args.start), 'Deleting', rangeText(args.start, args.end));
    case 'format_lines': return at(num(args.start), 'Formatting', rangeText(args.start, args.end));
    case 'replace_section': return typeof args.heading === 'string' ? `Writing in ${oneLineClip(args.heading)}` : '';
    case 'replace_all': return typeof args.old_text === 'string' ? `Replacing every "${oneLineClip(args.old_text)}"` : '';
    case 'replace_text': case 'format_text': {
      const n = lineOfText(args.old_text);
      return n ? at(n, name === 'replace_text' ? 'Writing' : 'Formatting', `line ${n}`) : '';
    }
    default: return '';
  }
}
const oneLineClip = (t) => { const s = String(t).replace(/\s+/g, ' ').trim(); return s.length > 40 ? s.slice(0, 40) + '…' : s; };
// The line follows the newest running call of this panel; nothing when none runs (never a scroll of the document).
function syncPlace(b, list) {
  const pending = list.filter((a) => a && a.log && a.status === 'pending');
  const text = pending.length ? placeText(pending[pending.length - 1]) : '';
  const p = b._parts;
  if (p.place.textContent !== text) p.place.textContent = text;
  p.place.classList.toggle('hidden', !text);
}

// ---- Manual-mode edit blocks ------------------------------------------------------------------
// The Manual prompt asks for an edit as <replacement>…</replacement> (the new text of the selection) or
// <insertion>…</insertion> (text for the cursor). A finished answer with exactly one well-formed block
// shows it as a labeled card whose buttons paste exactly the block; anything else renders as plain
// Markdown (the tags stay visible as text). History keeps the raw answer.
const EDIT_BLOCK_LABELS = { replacement: 'Replacement for the selection', insertion: 'Insertion at the cursor' };
const EDIT_TAG_RE = /<(\/?)(replacement|insertion)>/gi;
const FENCE_BEFORE_RE = /(^|\n)[ \t]*(`{3,}|~{3,})[\w+#.-]*[ \t]*\n?$/; // a fence line ending the prose before the block
const FENCE_AFTER_RE = /^[ \t]*\n?[ \t]*(`{3,}|~{3,})[ \t]*(?=\n|$)/; // its closing line right after the block

// Returns { kind, text, before, after } or null (no block, several, unbalanced, empty).
function parseEditBlock(src) {
  const s = String(src || '').replace(/\r\n/g, '\n');
  const tags = [...s.matchAll(EDIT_TAG_RE)];
  if (tags.length !== 2) return null;
  const [open, close] = tags;
  const kind = open[2].toLowerCase();
  if (open[1] || !close[1] || close[2].toLowerCase() !== kind) return null;
  // the tags usually stand on their own lines: drop one newline after the opening and before the closing tag
  const text = s.slice(open.index + open[0].length, close.index).replace(/^[ \t]*\n/, '').replace(/\n[ \t]*$/, '');
  if (!text.trim()) return null;
  let before = s.slice(0, open.index);
  let after = s.slice(close.index + close[0].length);
  if (FENCE_BEFORE_RE.test(before) && FENCE_AFTER_RE.test(after)) { // the block wrapped in a code fence
    before = before.replace(FENCE_BEFORE_RE, '$1');
    after = after.replace(FENCE_AFTER_RE, '');
  }
  return { kind, text, before, after };
}

// The answer's HTML: Markdown, or (finished answers only) the prose around an edit block plus the block card.
// Returns { html, codes, blockIdx } (blockIdx: the block's index in codes, or null).
function renderAnswer(text, streaming) {
  const block = streaming ? null : parseEditBlock(text);
  if (!block) return { ...renderMarkdown(text), blockIdx: null };
  const codes = [];
  let html = renderMarkdown(block.before, codes).html;
  const idx = codes.push(block.text) - 1;
  html += `<div class="code-wrap edit-block ${block.kind}"><div class="code-bar">` +
    `<span class="code-lang">${escapeHtml(EDIT_BLOCK_LABELS[block.kind])}</span>` +
    actionButtons('apply-code', 'copy-code', idx) +
    `</div><pre>${escapeHtml(block.text)}</pre></div>`;
  html += renderMarkdown(block.after, codes).html;
  return { html, codes, blockIdx: idx };
}

// Icon for a tool call: the panel's own tools, else a server-side persona tool (best effort by name).
function activityIcon(name) {
  if (extraIcon(name)) return extraIcon(name); // registerTools
  if (READING_TOOL_ICONS[name]) return READING_TOOL_ICONS[name];
  if (EDIT_TOOL_ICONS[name]) return EDIT_TOOL_ICONS[name];
  const n = String(name || '').toLowerCase();
  if (/scholar|openalex|paper|arxiv|pubmed|citation|literature|db/.test(n)) return '📄';
  if (/fetch|browse|open|read|url|page/.test(n)) return '🌐';
  if (/search|query|find/.test(n)) return '🔍';
  return '🛠️';
}

// Short one-line summary of tool arguments: the query if present, otherwise compact JSON.
function activitySummary(args) {
  if (args == null) return '';
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch (e) { return args.length > 80 ? args.slice(0, 80) + '…' : args; }
  }
  if (typeof args === 'object') {
    for (const k of ['query', 'q', 'search_query', 'search', 'title', 'url', 'doi']) {
      if (typeof args[k] === 'string' && args[k].trim()) return args[k].trim();
    }
  }
  let s = '';
  try { s = JSON.stringify(args); } catch (e) { s = String(args); }
  return s.length > 80 ? s.slice(0, 80) + '…' : s;
}

// Text for an expanded log row, cut at LOG_MAX_CHARS with the full length noted.
function clipLog(text) {
  const t = String(text);
  return t.length > LOG_MAX_CHARS ? `${t.slice(0, LOG_MAX_CHARS)}\n[… truncated: ${fmtNum(t.length)} characters in total]` : t;
}
// Arguments of a tool call, one "key: value" per argument (string values verbatim).
function formatToolArgs(args) {
  if (typeof args === 'string') return args; // unparsable JSON, shown as received
  const keys = Object.keys(args || {});
  return keys.map((k) => `${k}: ${typeof args[k] === 'string' ? args[k] : JSON.stringify(args[k])}`).join('\n');
}
const LOG_STATUS = { pending: ' ⏳', fail: ' ⚠️', rejected: ' ✖ rejected', ok: '' };

// One row of the activity area: an expandable log row (tool call of this panel: summary line, then the
// full arguments and the result text), a pending row (call still running) or a plain persona row.
function activityRow(a) {
  const name = escapeHtml(a.name || 'tool');
  const line = `${escapeHtml(activityIcon(a.name))} <span class="activity-name">${name}</span>${a.summary ? ': ' + escapeHtml(a.summary) : ''}`;
  const title = (a.name || 'tool') + (a.summary ? ': ' + a.summary : '');
  if (!a.log || a.status === 'pending') {
    const row = document.createElement('div');
    row.className = 'activity-row' + (a.log ? ' log-row pending' : '');
    row.innerHTML = line + (a.log ? escapeHtml(LOG_STATUS.pending) : '');
    row.title = title;
    return row;
  }
  const row = document.createElement('details');
  row.className = 'activity-row log-row ' + a.status;
  const args = formatToolArgs(a.args);
  const res = a.result == null ? '' : a.result;
  // A result replaced by a stub after its turn (slimHistory): its original size.
  const size = a.omitted ? `omitted, was ${fmtNum(a.omitted)} characters` : `${fmtNum(res.length)} character${res.length === 1 ? '' : 's'}`;
  row.innerHTML = `<summary title="${escapeHtml(title)}">${line}${escapeHtml(LOG_STATUS[a.status] || '')}</summary><div class="log-body">` +
    (args ? `<div class="log-label">Arguments</div><pre>${escapeHtml(clipLog(args))}</pre>` : '') +
    `<div class="log-label">Result (${size})</div><pre>${escapeHtml(clipLog(res)) || '(empty)'}</pre></div>`;
  return row;
}
const activityKey = (a) => (a.log ? `${a.status}|${a.result == null ? '' : a.result.length}` : 'plain|' + (a.summary || ''));

// Brings the bubble's activity rows in line with the list: new entries are appended, entries whose
// state changed (a call finished) replace their row.
function renderActivity(b, activity) {
  const p = b._parts;
  const list = Array.isArray(activity) ? activity : [];
  list.forEach((a, i) => {
    const key = activityKey(a || {});
    const old = b._rows[i];
    if (old && old._key === key) return;
    const row = activityRow(a || {});
    row._key = key;
    if (old) old.replaceWith(row); else p.activity.appendChild(row);
    b._rows[i] = row;
  });
  p.activity.classList.toggle('hidden', !list.length);
}

function updateAssistantBubble(b, { text = '', reasoning = '', streaming = false, usage = null, activity = null } = {}) {
  const p = b._parts;
  const list = Array.isArray(activity) ? activity : [];
  renderActivity(b, activity);
  p.think.classList.toggle('hidden', !reasoning);
  syncOrb(b, orbModeFor(b, text || '', reasoning || '', streaming, list)); // after the Thinking toggle: its place
  syncPlace(b, list);
  if (reasoning && b._reasoning !== reasoning) { p.body.textContent = reasoning; b._reasoning = reasoning; }
  const thinkingLive = streaming && !!reasoning && !text;
  p.think.classList.toggle('live', thinkingLive);
  p.label.textContent = thinkingLive ? 'Thinking…' : 'Thinking';
  if (b._text !== text || b._lastStreaming !== streaming) {
    const { html, codes, blockIdx } = renderAnswer(text, streaming);
    p.md.innerHTML = html;
    b._codes = codes;
    b._text = text;
    if (b._blockIdx !== blockIdx) { // with an edit block, the answer's own buttons apply and copy only the block
      p.actions.innerHTML = blockIdx == null ? actionButtons('apply-msg', 'copy-msg') : actionButtons('apply-code', 'copy-code', blockIdx);
      b._blockIdx = blockIdx;
    }
  }
  p.md.classList.toggle('hidden', !text);
  b.classList.toggle('typing', !!streaming);
  b._lastStreaming = streaming;
  p.actions.classList.toggle('hidden', streaming || !text.trim());
  const total = usage && Number.isFinite(Number(usage.total_tokens)) ? Number(usage.total_tokens) : null;
  if (total != null && !streaming) {
    p.meta.textContent = `${fmtNum(total)} tokens`;
    const extra = [];
    if (usage.cache_read_input_tokens) extra.push(`Cached: ${fmtNum(usage.cache_read_input_tokens)}`);
    if (usage.reasoning_tokens) extra.push(`Reasoning: ${fmtNum(usage.reasoning_tokens)}`);
    if (usage.web_search_requests) extra.push(`Web searches: ${fmtNum(usage.web_search_requests)}`);
    p.meta.title = [`Prompt: ${fmtNum(usage.prompt_tokens || 0)}`, `Completion: ${fmtNum(usage.completion_tokens || 0)}`, ...extra].join(' · ');
    p.meta.classList.remove('hidden');
  } else {
    p.meta.classList.add('hidden');
  }
}

// Card of a document edit. opts: label (summary of the text details, default "Inserted text"), icon
// (instead of ✅), editId (journaled edit: an Undo button while it is the most recent undoable one),
// undone (the edit was undone later), revertId / reverted (a remember change: its Revert button), diff ({ oldText,
// newText } of an applied replacement: a folded "What changed" by words in place of the text details; a record of
// the edit, not a preview).
function toolCard(status, message, text, detail, opts = {}) {
  const d = document.createElement('div');
  d.className = 'tool-card ' + (status === 'ok' ? 'ok' : status === 'fail' ? 'fail' : '');
  const title = status === 'ok' ? (opts.icon || '✅') + ' ' + (message || 'Replaced in document') + (opts.undone ? ' (undone)' : '')
    : status === 'fail' ? '⚠️ ' + (message || 'Replacement failed')
      : '⏳ ' + (message || 'Replacing the selection in the document…');
  const latest = latestUndoable();
  const canUndo = opts.editId && !opts.undone && state.googleConnected && latest && latest._edit.id === opts.editId;
  const many = canUndo ? answerEdits(opts.editId).length : 0; // "Undo all": the answer made 2+ undoable edits
  const undoAll = many >= 2
    ? ` <button class="btn small" type="button" data-act="undo-all" data-edit="${escapeHtml(opts.editId)}" title="Check all ${many} edits of this answer, then revert them newest first">Undo all (${many})</button>`
    : '';
  const undo = canUndo
    ? `<div class="tool-actions"><button class="btn small" type="button" data-act="undo-edit" data-edit="${escapeHtml(opts.editId)}" title="Revert this edit in the document">Undo</button>${undoAll}</div>`
    : '';
  // remember: Revert works once; afterwards the disabled button says so.
  const revert = opts.revertId
    ? `<div class="tool-actions"><button class="btn small" type="button" data-act="revert-remember" data-call="${escapeHtml(opts.revertId)}"${opts.reverted ? ' disabled' : ''} title="Undo this change of the document instructions">${opts.reverted ? 'Reverted' : 'Revert'}</button></div>`
    : '';
  d.innerHTML = `<div>${escapeHtml(title)}</div>` +
    (detail ? `<div class="detail">${escapeHtml(detail)}</div>` : '') +
    (opts.diff ? `<details class="what-changed"><summary>What changed</summary><div class="word-diff">${wordDiffHtml(wordDiff(opts.diff.oldText, opts.diff.newText))}</div></details>`
      : text ? `<details><summary>${escapeHtml(opts.label || 'Inserted text')}</summary><pre>${escapeHtml(text)}</pre></details>` : '') + undo + revert;
  appendToChat(d);
  if (opts.editId) editCards.set(opts.editId, d);
  return d;
}

// Card for a finished editing tool call (replace_selection, the Docs API writing tools, undo).
function toolCardFor(tc, r) {
  const { args } = parseToolArgs(tc);
  if (!r) return toolCard('fail', 'No result', '', '');
  const text = r._cardText !== undefined ? r._cardText : typeof args.text === 'string' ? args.text : '';
  return toolCard(r._ok ? 'ok' : 'fail', r._message || (r._ok ? 'Replaced in document' : r.content), text, r._detail,
    { label: r._cardLabel, icon: r._icon, diff: editDiff(tc, args, r), editId: r._ok && r._edit ? r._edit.id : null, undone: !!(r._edit && r._edit.undone),
      revertId: r._ok && r._remember ? r.tool_call_id : null, reverted: !!(r._remember && r._remember.reverted) });
}

// The old and new text of an applied replacement for its "What changed" fold, or null (insertions and deletions show
// their text as before). replace_text and replace_all: the call's own old_text and new_text (whole words, as the
// model wrote them); replace_section and replace_selection: the journal's replaced middle (the part that differed).
const DIFF_TOOLS = ['replace_text', 'replace_all', 'replace_section', 'replace_selection'];
function editDiff(tc, args, r) {
  const name = tc && tc.function && tc.function.name;
  if (!r || !r._ok || !DIFF_TOOLS.includes(name)) return null;
  if ((name === 'replace_text' || name === 'replace_all') && typeof args.old_text === 'string' && typeof args.new_text === 'string') {
    return args.old_text === args.new_text ? null : { oldText: args.old_text, newText: args.new_text };
  }
  const e = r._edit;
  if (!e || e.kind !== 'replace' || typeof e.restore !== 'string' || typeof e.text !== 'string' || e.restore === e.text) return null;
  return { oldText: e.restore, newText: e.text };
}

// Pending card text while an editing tool call is streaming.
const REMEMBER_PENDING = 'Updating the document instructions…';
const pendingCardText = (name) => (name === REPLACE_TOOL.function.name ? '' : name === 'undo_last_edit' ? 'Undoing the last edit…'
  : name === 'remember' ? REMEMBER_PENDING : (extraTool(name) && extraTool(name).pending) || 'Editing the document…');
// A registered tool (registerTools) gets an edit card unless it is always a reading tool (a tool whose calls
// only sometimes read gets one; the tool loop removes it for its reading calls).
const isEditTool = (name) => name === REPLACE_TOOL.function.name || WRITE_TOOLS.includes(name) || (!!extraTool(name) && extraTool(name).reading !== true);

function renderEmpty() {
  // Only the slash-command hint (dimmed); no other onboarding text.
  el.chat.innerHTML = '<div class="empty">Start a message with <strong>/research</strong>, <strong>/code</strong> or ' +
    '<strong>/chat</strong> to give that turn a research, coding or general focus (answers stay in the chat; ' +
    'with Munin these turns run through its own assistants with web + paper search).</div>';
}

// Parses tool-call arguments; returns { args, error }.
function parseToolArgs(tc) {
  const raw = (tc && tc.function && tc.function.arguments) || '';
  if (!raw.trim()) return { args: {}, error: null };
  try {
    const args = JSON.parse(raw);
    return { args: args && typeof args === 'object' ? args : {}, error: null };
  } catch (e) {
    return { args: {}, error: raw };
  }
}

// The divider row of a compaction boundary, expandable to the text that replaced the messages above it
// (plain text, escaped): "Earlier conversation summarized · N messages" for a summary written by the
// model, "Earlier conversation condensed · N messages" for a fold (_folded: built without a request).
function addSummaryDivider(m) {
  const d = document.createElement('details');
  const folded = !!m._folded;
  d.className = folded ? 'summary-divider folded' : 'summary-divider';
  d.title = folded ? 'Older turns were condensed to one line per tool call. Click to read what the model now gets.'
    : 'Older turns were summarized by the model. Click to read the summary.';
  const n = Number(m._covers) || 0;
  let text = String(m.content || '').replace(SUMMARY_PREFIX, '');
  if (folded) text = text.replace(FOLD_NOTE, ''); // the fold's note on its format is for the model
  text = text.trim();
  d.innerHTML = `<summary>Earlier conversation ${folded ? 'condensed' : 'summarized'} · ${fmtNum(n)} message${n === 1 ? '' : 's'}</summary><div class="summary-text">${escapeHtml(text)}</div>`;
  return appendToChat(d, false);
}

// The stored automatic continuation (a user-role message with _auto, see toolLoop): a small notice-style row,
// not a user bubble; it stays (it is in the history). The same text as the live notice.
function addAutoRow() {
  const d = addBubble('notice auto-continue', escapeHtml(AUTO_CONTINUE_NOTICE));
  d.title = 'The panel sent this automatically, once per answer';
  return d;
}

// Re-render that keeps the notices and errors currently shown (renderHistory drops them): used after a
// compaction at the start of a turn, so notices of this turn (long document, API fallback) stay visible.
function renderHistoryKeepingNotices() {
  // The rows of stored automatic continuations are drawn again by renderHistory.
  const keep = [...el.chat.querySelectorAll('.msg.notice'), ...el.chat.querySelectorAll('.msg.error')].filter((n) => !n.classList.contains('auto-continue'));
  renderHistory();
  for (const n of keep) el.chat.appendChild(n);
}

// The side exchange of this chat, put back at the end after a re-render.
function keepSideBubbles() {
  for (const b of sideBubbles) appendToChat(b, false);
}

// A Plan answer's buttons: Copy, and Do it when it is the latest message of the chat (doPlanFromButton in turn.js).
// No Apply: a plan is no document text.
function planActions(b, latest) {
  const p = b._parts;
  p.actions.innerHTML = (latest ? '<button class="btn small primary plan-do" type="button" data-act="plan-do" title="Switch to Edit automatically and carry out this plan">Do it</button>' : '') +
    actionButtons(null, 'copy-msg');
  b._blockIdx = -1; // a later update of this bubble rebuilds the buttons
}

// Full chat re-render from the history.
function renderHistory() {
  watchChat();
  el.chat.innerHTML = '';
  editCards.clear();
  syncSideThread();
  if (!state.messages.length) { renderEmpty(); keepSideBubbles(); renderContextGauge(); return; }
  const results = new Map();
  for (const m of state.messages) if (m.role === 'tool') results.set(m.tool_call_id, m);
  for (const m of state.messages) {
    // Messages replaced by a summary are shown as before, slightly dimmed.
    const dim = (n) => { if (n && m._compacted) n.classList.add('compacted'); return n; };
    if (m.role === 'user' && m._summary) {
      dim(addSummaryDivider(m));
    } else if (m.role === 'user' && m._auto) {
      dim(addAutoRow());
    } else if (m.role === 'user') {
      if (m.content.trim()) dim(userBubble(m.content, m._persona));
    } else if (m.role === 'assistant') {
      const text = m.content || '';
      // Munin persona tool activity (plain rows) plus the action log of the round's tool calls.
      const activity = [...(Array.isArray(m._toolActivity) ? m._toolActivity : []), ...actionLogFromToolCalls(m.tool_calls, results)];
      if (text.trim() || m._reasoning || activity.length) {
        const b = dim(addAssistantBubble());
        updateAssistantBubble(b, { text, reasoning: m._reasoning || '', usage: m._usage || null, activity });
        if (m._sources) renderSources(b, m._sources);
        if (m._plan) planActions(b, m === state.messages[state.messages.length - 1]);
      }
      for (const tc of m.tool_calls || []) {
        if (isReadingTool(tc)) continue; // in the action log only
        dim(toolCardFor(tc, results.get(tc.id)));
      }
    }
  }
  // A permission card still waiting for a decision (only possible if something re-renders mid-turn)
  // stays usable: it is put back at the end.
  for (const p of pendingPreviews.values()) el.chat.appendChild(p.card);
  keepSideBubbles();
  scrollToBottom(true);
  renderContextGauge(); // every turn end, chat switch, compaction and reload passes through here
}

// ---------------------------------------------------------------------------
// Context gauge: how full the model's context is (the composer's control bar, next to Send)
// ---------------------------------------------------------------------------
// Short token count: "850", "4.2k", "41k".
const fmtTokensK = (n) => (n < 1000 ? String(Math.round(n)) : n < 10000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : `${Math.round(n / 1000)}k`);

// The newest usage the provider reported for the current turn's requests (the last round of the latest
// turn), or null: a turn that failed before any reply, or a provider that reported none.
function latestMeasuredUsage(active) {
  const lastUser = lastUserIndex(active);
  for (let i = active.length - 1; i > lastUser; i--) {
    const m = active[i];
    if (m.role === 'assistant' && m._usage && Number(m._usage.prompt_tokens) > 0) return m._usage;
  }
  return null;
}

// Estimated size of the next request without its new message: the compaction check's own estimate
// (requestTokens in compaction.js), so the gauge and the compaction never disagree. The snapshot is a throwaway
// view of the panel state, not takeSnapshot() (that one stands for a turn).
function nextRequestEstimate(mode, active) {
  try {
    const snap = { prov: activeProvider(), cfg: { ...activeConfig() }, signal: null };
    snapshotDocument(snap);
    return requestTokens(mode, snap, active);
  } catch (e) {
    return estimateTokens(active); // the history alone (cannot fail the render)
  }
}

// The gauge's numbers, or null for an empty chat. used: the measured size of the last request (prompt +
// reply, as the provider counted it) or, when the latest turn has no usage, the estimate of the next one.
// compactAt: the size at which a turn compacts the history (compactionBudget: COMPACT_AT_TOKENS for OpenAI
// and Anthropic, the hard budget for Munin). warn: the measured or estimated size is near compactAt.
function contextGauge() {
  const active = activeHistory(state.messages);
  if (lastUserIndex(active) < 0) return null;
  const prov = activeProvider();
  const mode = applyTurnMode();
  const compactAt = compactionBudget(mode, { prov });
  const estimate = nextRequestEstimate(mode, active);
  const usage = latestMeasuredUsage(active);
  const prompt = usage ? Number(usage.prompt_tokens) : 0;
  const reply = usage ? Number(usage.completion_tokens) || 0 : 0;
  const used = usage ? prompt + reply : estimate;
  return { used, measured: !!usage, prompt, reply, estimate, window: prov.contextTokens, compactAt, label: prov.label,
    warn: Math.max(used, estimate) >= GAUGE_WARN_RATIO * compactAt };
}

function renderContextGauge() {
  const box = $('contextGauge');
  if (!box) return;
  let g = null;
  try { g = contextGauge(); } catch (e) { g = null; }
  box.classList.toggle('hidden', !g);
  if (!g) return;
  const pct = (n) => `${Math.min(100, Math.max(0, (n / g.window) * 100)).toFixed(1)}%`;
  $('contextFill').style.width = pct(g.used);
  $('contextMark').style.left = pct(g.compactAt);
  $('contextText').textContent = `Context ${g.measured ? '' : '~'}${fmtTokensK(g.used)} / ${fmtTokensK(g.window)}`;
  // role="img" hides the children from screen readers, so the label carries the numbers.
  box.setAttribute('aria-label', `Context: ${g.measured ? '' : 'about '}${fmtNum(g.used)} of ${fmtNum(g.window)} tokens${g.measured ? '' : ' (estimated)'}`);
  box.classList.toggle('warn', g.warn);
  box.classList.toggle('estimated', !g.measured);
  box.title = [
    g.measured
      ? `Last request: ${fmtNum(g.used)} tokens, measured by the provider (prompt ${fmtNum(g.prompt)} + reply ${fmtNum(g.reply)}).`
      : `Next request: about ${fmtNum(g.used)} tokens, estimated from this chat (your next message comes on top).`,
    `${g.label} context window: ${fmtNum(g.window)} tokens.`,
    `The history is compacted when a request is estimated above ${fmtNum(g.compactAt)} tokens` +
      (g.measured ? ` (next request now: about ${fmtNum(g.estimate)}).` : '.'),
  ].join('\n');
}
