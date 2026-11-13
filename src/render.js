'use strict';
// Module render.js: chat rendering: bubbles, errors, the turn's own rows (addTurnRow), tool cards, the action-log rows
// (renderActivity), the edit blocks of the read-only chat turns (parseEditBlock), the /side bubbles (syncSideThread), the bubble's footer
// status (bubbleStatus: its text, the thinking orb's mode, the frozen frame of a stopped or failed turn), the location of a
// running read or write (placeText) and its state words (KIND_WORDS), the "What changed" fold of an applied replacement (editDiff, word-diff.js),
// renderHistory and the context gauge (renderContextGauge).
/* global answeredCard, logEntry, agentAccessText, agentLive, readScope, readIncludes, $, chatAccount, healthState, healthTitle, syncRowModels, PROVIDERS, typeName, actionButtons, agentLabel, attachedLine, AGENT_REPORT_NOTE, stopAgent, appendToChat, actionLogFromToolCalls, activeConfig, activeHistory, activeProvider, answerEdits, AUTO_CONTINUE_NOTICE, CONTINUE_TEXT,
   ASK_USER_TOOL, cachesPrompt, compactionBudget, tokenBudget, docLines, docOutline, editCards, el, escapeHtml, estimateTokens, extraTool, fmtNum,
   isMainDocRef, oneLine, rememberUndoText,
   FOLD_NOTE, GAUGE_WARN_RATIO, isReadingTool, lastUserIndex, latestUndoable, LOG_MAX_CHARS, saveHistory,
   openSettings, orbCreate, orbSetState, pendingPreviews, PERSONAS, renderMarkdown, renderSources,
   REPLACE_TOOL, requestTokens, scrollToBottom, snapshotDocument, state, SUMMARY_PREFIX_RE, FAILED_TURN_ROW, watchCards, wordDiff, wordDiffHtml, WRITE_TOOLS,
   ZOTERO_TOKEN_RE, applyTurnMode */
/* exported addAutoRow, addTurnRow, addLateTurnRow, addChatRow, beginTurnRows, anchorTurnRows, endTurnRows, turnRowsOpen, takeRowsBubble, nextRound, dropTurnOrb, refreshCallRow, addError, addUserBubble, addAssistantBubble, activitySummary, updateAssistantBubble,
   toolCard, toolCardFor, writeRowInfo, rememberLine, onChatRedraw, activityRow, cardLineHtml, pendingCardText, REMEMBER_PENDING, isEditTool, renderEmpty, parseToolArgs, renderHistoryKeepingUnstored,
   renderHistory, renderContextGauge, renderChatModel, syncSideThread, forgetSideBubbles, lastSentText, placeText, headingAbove, editDiff,
   agentBlockStart, agentBlockProgress, agentBlockFinish, agentBlockFor, agentStartBlock, ownBlock, syncToolGroup,
   startAssistantRound, dropAssistantRound, endAssistantBubble, paintBubble, staleActivityRow, answeredCardsFor, placeRoundCard, settleRoundCard, placeAnsweredCard,
   placeAgentCard, placeAgentResultCard, agentCardInfo */

// ---------------------------------------------------------------------------
// Chat rendering
// ---------------------------------------------------------------------------
function addBubble(cls, html) {
  const d = document.createElement('div');
  d.className = 'msg ' + cls;
  d.innerHTML = html;
  return appendToChat(d);
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

// ---- The turn's own rows ----------------------------------------------------------------------------------------
// What happened to a turn besides its calls (how it or a command ended, the panel's own requests, a fact found on the
// way: the document read through the export, older messages left out) is a row of the turn's bubble, drawn like a tool
// row of the action log: the muted row type, no frame, no colour, a timeline item of its own in the order it arose
// among the rounds; a row with a detail opens to it. Stored on the turn's message that was the last one when the row
// arose, as _notes: [text | { text, detail?, act? }] (act 'continue': the Continue button while that message is the
// chat's last); renderHistory draws them after that message's round. Never sent to the model (no "_" field is).
// The running main turn (runTurn): { pending: [] } until its user message is stored (anchorTurnRows moves them onto
// it), then { messages }: a row goes onto the last message. A /side turn's rows are drawn only (nothing is stored).
let turnRows = null;
function beginTurnRows() { turnRows = { pending: [] }; }
function anchorTurnRows(userMsg, messages) {
  const pending = turnRows && turnRows.pending ? turnRows.pending : [];
  if (pending.length) userMsg._notes = [...(Array.isArray(userMsg._notes) ? userMsg._notes : []), ...pending];
  turnRows = { messages };
}
function endTurnRows() { turnRows = null; }
const turnRowsOpen = () => !!turnRows || !!state.sideTurn;
const lastOf = (list) => (list && list.length ? list[list.length - 1] : null);
const pushNote = (m, note) => { (Array.isArray(m._notes) ? m._notes : (m._notes = [])).push(note); };

// A row of the running turn (at: a message to store it on instead, also outside a turn: a finish hook's result).
// store false: drawn only (the stored _auto messages are their own record). tip: the row's tooltip (not stored).
// Returns false when there is no turn to put it in (nothing is shown).
function addTurnRow(text, { at = null, store = true, detail = '', act = '', tip = '' } = {}) {
  if (!at && !turnRowsOpen()) return false;
  const note = detail || act ? { text: String(text), ...(detail ? { detail: String(detail) } : {}), ...(act ? { act } : {}) } : String(text);
  if (store) {
    if (at) pushNote(at, note);
    else if (turnRows && turnRows.pending) turnRows.pending.push(note);
    else if (turnRows && lastOf(turnRows.messages)) pushNote(lastOf(turnRows.messages), note);
  }
  // A message of an earlier turn: the chat is drawn again (not while a turn runs: its own re-render comes).
  if (at && !state.sideTurn && at !== lastOf(state.messages)) {
    if (!state.busy && state.messages.includes(at)) renderHistory();
    return true;
  }
  drawTurnRow(turnBubble(), note, { tip, latest: true });
  return true;
}
// A row found after the turn ended (an async finish hook, a background compaction): stored on at once the panel is idle,
// drawn, and the chat saved. Nothing when at is no longer in the open chat (another chat, a history read again).
function addLateTurnRow(text, at, opts = {}, tries = 1200) {
  if (!at) return;
  if (state.busy) { if (tries > 0) setTimeout(() => addLateTurnRow(text, at, opts, tries - 1), 50); return; }
  if (!state.messages.includes(at)) return;
  addTurnRow(text, { ...opts, at });
  Promise.resolve(saveHistory()).catch(() => {});
}
// The bubble of the turn the rows go into: the last bubble after the last user message (of the side thread in a /side
// turn), else a new one holding rows only, which the turn's first answer then takes over (takeRowsBubble).
// stopAtBlock: an agent's block ends the search too (a report turn starts after its block: takeRowsBubble).
function lastTurnBubble(stopAtBlock = false) {
  const side = !!state.sideTurn;
  const kids = [...el.chat.children];
  for (let i = kids.length - 1; i >= 0; i--) {
    const n = kids[i];
    const c = n && n.classList;
    if (stopAtBlock && c && c.contains('agent-block')) return null;
    if (!c || !(c.contains('user') || c.contains('assistant')) || c.contains('side') !== side) continue;
    return c.contains('assistant') && n._parts ? n : null;
  }
  return null;
}
function rowsBubble() {
  const b = addAssistantBubble();
  b._rowsOnly = true;
  return b;
}
const turnBubble = () => lastTurnBubble() || rowsBubble();
// The bubble that so far holds only this turn's rows, for the turn's first answer (liveAnswer, endSideBubble), or null.
function takeRowsBubble() {
  const b = lastTurnBubble(true);
  if (!b || !b._rowsOnly || b._live) return null;
  b._rowsOnly = false;
  nextRound(b);
  return b;
}
// A round shows something or runs (a round that does neither is reused, so rows drawn before it stay above it).
const roundUsed = (r) => !!(r.list.length || r.text || r.reasoning || r.streaming || r.workedMs || r.parts.sources || r.parts.rows.querySelector(CALL_CARD_SEL));
// The bubble's round for the next answer: its last one while unused, else a new one.
function nextRound(b) {
  const r = b._rounds[b._rounds.length - 1];
  return r && !roundUsed(r) ? r : startAssistantRound(b);
}
// Draws a stored or live row in bubble b: before the bubble's last round while that one is unused, else at the end.
// latest: the row's message is the chat's last one (a row with act 'continue' offers its button only then).
function drawTurnRow(b, note, { tip = '', latest = false } = {}) {
  const item = turnRowEl(note, tip, latest);
  const r = b._rounds[b._rounds.length - 1];
  if (r && !roundUsed(r)) r.el.before(item); else b._parts.rows.appendChild(item);
  b._notes.push(item);
  paintBubble(b);
  return item;
}
function turnRowEl(note, tip, latest) {
  const n = note && typeof note === 'object' ? note : { text: String(note == null ? '' : note) };
  const item = document.createElement('div');
  item.className = 'note-stage';
  item._text = String(n.text || ''); // what the row says (the tests read it)
  const row = document.createElement(n.detail ? 'details' : 'div');
  row.className = 'activity-row note-row' + (n.detail ? ' log-row' : '');
  if (n.detail) row.innerHTML = `<summary>${escapeHtml(n.text)}</summary><div class="log-body"><div class="log-detail">${escapeHtml(n.detail)}</div></div>`;
  else row.textContent = String(n.text || '');
  if (tip) row.dataset.tip = tip;
  item.appendChild(row);
  if (n.act === 'continue' && latest) {
    // The wrap-up's Continue (main.js data-act "continue-turn"): sends CONTINUE_TEXT once.
    const acts = document.createElement('span');
    acts.className = 'row-acts';
    const btn = document.createElement('button');
    btn.className = 'row-act';
    btn.type = 'button';
    btn.dataset.act = 'continue-turn';
    btn.dataset.tip = `Send "${CONTINUE_TEXT}"`;
    btn.textContent = 'Continue';
    acts.appendChild(btn);
    item.classList.add('with-acts');
    item.appendChild(acts);
  }
  return item;
}
// A row outside any turn (Stop before the turn began, a command's outcome): at the end of the chat, in the rail's text
// column like the bubbles' rows; not stored, kept by renderHistoryKeepingUnstored.
function addChatRow(text) {
  const d = document.createElement('div');
  d.className = 'msg chat-row';
  d._text = String(text);
  const row = document.createElement('div');
  row.className = 'activity-row note-row';
  row.textContent = String(text);
  d.appendChild(row);
  return appendToChat(d);
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
  badge.dataset.tip = 'Side question, not saved';
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
function addUserBubble(text, persona, files) {
  sentText = String(text || '');
  turnOrb = null;
  return userBubble(text, persona, files);
}
// persona: set for slash-command turns ("research" | "code" | "chat"); shows a small badge. files: the message's
// attached files (_files), one "Attached:" line each.
function userBubble(text, persona, files) {
  const d = addBubble('user', '');
  markSide(d);
  const p = persona && PERSONAS[persona];
  if (p) {
    const badge = document.createElement('span');
    badge.className = 'persona-badge';
    badge.textContent = `/${persona}`;
    badge.dataset.tip = `Sent with /${persona}`;
    d.appendChild(badge);
  }
  appendWithChips(d, String(text));
  for (const f of Array.isArray(files) ? files : []) {
    const line = document.createElement('div');
    line.className = 'attach-line';
    line.textContent = attachedLine(f);
    d.appendChild(line);
  }
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
    chip.dataset.tip = `Zotero item ${m[2].toUpperCase()}`;
    d.appendChild(chip);
    last = m.index + m[0].length;
  }
  if (last < text.length) d.appendChild(document.createTextNode(text.slice(last)));
}

// Assistant bubble: ONE per turn (the owner's choice: a turn with several tool rounds is one message with stages).
// Its slots, in a fixed order, made once here and never reordered (only an answered card moves into its stage):
//   1. the activity: the stages, one per tool round, each with the round's own text first (what the model wrote before
//      its calls), then its action row (rows, result and answered cards), then the round's Sources;
//   2. the answer: the text of the rounds after the last one with calls (the final answer, or the reply that streams
//      now) in Markdown, Apply / Copy in its top right corner, shown while the pointer is over the bubble or focus is
//      inside it;
//   3. the cards that wait on the user (.msg-cards): a decision card of a call of this turn, never inside a fold;
//   4. extra (a Plan answer's Do it);
//   5. the footer (.msg-foot), always the last line: its first row left the status, details.thinking > summary >
//      [canvas.orb][span.thinking-label] (live: what happens now, the orb in place of the marker; ended: "Worked for Ns"
//      and the like, the marker when there is reasoning to open; bubbleStatus), right the token line (.msg-meta), once
//      the turn has ended; its second row the body .thinking-body (the reasoning of every round), a sibling after the
//      token line, shown while the details is open (syncThinkingBody) at the bubble's full width and height, so the
//      token line stays beside the label. Chrome: unselectable, never copied.
// The timeline rail (the owner's choice, like Claude Code's panel): each shown stage and the answer are the items of one
// sequence (.tl-item): a dot each, joined by one line on the left (sidepanel.css); syncRail marks the first and the last
// shown item (the line runs between their dots), the live one (the accent dot) and a round with a failed or refused call
// (a red dot: the owner's choice, the tool name keeps the row's colour). The cards, extra and the footer
// stand outside it.
// The orb goes into the summary when it is first needed (a bubble from the history never gets one) and stays there.
// A round is added with startAssistantRound; updateAssistantBubble always updates the bubble's last round. b._live: the
// turn runs (liveAnswer's ensureBubble sets it; endAssistantBubble or the final renderHistory ends it).
function addAssistantBubble() {
  const b = addBubble('assistant', '');
  markSide(b);
  const activity = document.createElement('div');
  activity.className = 'activity hidden';
  // The tool calls of the turn: one stage per round (startAssistantRound, syncStages), each its own timeline item.
  const rows = document.createElement('div');
  rows.className = 'activity-rows';
  activity.append(rows);
  const md = document.createElement('div');
  md.className = 'md msg-text';
  // The answer's frame (a timeline item). An edit block's Insert / Copy are in the block's own bar, nowhere else.
  const answer = document.createElement('div');
  answer.className = 'msg-answer';
  answer.append(md);
  const cards = document.createElement('div'); // the decision cards that wait on the user (placeRoundCard)
  cards.className = 'msg-cards hidden';
  const extra = document.createElement('div'); // buttons that stay visible below the answer (Do it)
  extra.className = 'msg-extra hidden';
  const foot = document.createElement('div');
  foot.className = 'msg-foot hidden';
  const think = document.createElement('details');
  think.className = 'thinking hidden';
  const sum = document.createElement('summary');
  const label = document.createElement('span');
  label.className = 'thinking-label';
  label.textContent = 'Thinking';
  sum.appendChild(label);
  think.append(sum);
  // The reasoning is the footer's second row, outside the details: inside it, it would share the row with the token line
  // (sidepanel.css .msg-foot). The details still owns the open state; its toggle shows or hides the body.
  const body = document.createElement('div');
  body.className = 'thinking-body hidden';
  think.addEventListener('toggle', () => syncThinkingBody(think, body));
  const meta = document.createElement('div');
  meta.className = 'msg-meta hidden';
  foot.append(think, meta, body);
  b.append(activity, answer, cards, extra, foot);
  b._parts = { think, sum, label, body, activity, rows, md, answer, cards, extra, foot, meta };
  b._rounds = [];
  b._rows = []; // the drawn rows of all rounds, in call order (renderActivity)
  b._notes = []; // the turn's own rows (drawTurnRow), timeline items between the rounds' stages
  b._list = []; // their entries
  b._text = '';
  b._codes = [];
  b._blockIdx = null; // index in _codes of the answer's edit block (parseEditBlock), or null
  b._orb = null; // the thinking orb (orb.js), made in the footer's summary by the first paint that needs it (syncOrb)
  b._orbMode = null;
  b._live = false;
  startAssistantRound(b);
  return b;
}

// ---- Rounds and stages -----------------------------------------------------------------------------------------
// A round of the turn (one model response and its tool calls) in the bubble: its state as the last update gave it and
// its stage element in the activity area, one timeline item in the order things arose (the owner's choice): the round's
// own text when it is not in the answer (Markdown in the answer's text style: it is the model's message too; it came
// before the calls), its action row (a round with one call: that call's row; with two or more: the head "Actions N",
// folded by default, over the rows), then the round's Sources (web-search.js renderSources: the links its searches
// found, where they were used). Live and ended alike, so the turn's end moves nothing.
// streaming: the round's stream is open; last: what that stream delivered last ('reasoning' | 'activity' | 'call' |
// 'text', from the stream hooks of turn.js), which the footer's status follows.
function startAssistantRound(b) {
  const stage = document.createElement('div');
  stage.className = 'stage hidden';
  const head = document.createElement('div'); // the round's action row with two or more calls (syncToolGroup)
  head.className = 'stage-head hidden';
  const line = document.createElement('button');
  line.type = 'button';
  line.className = 'stage-line';
  line.setAttribute('aria-expanded', 'false');
  const acts = document.createElement('span');
  acts.className = 'row-acts';
  head.append(line, acts);
  const rows = document.createElement('div');
  rows.className = 'stage-rows';
  const text = document.createElement('div');
  text.className = 'stage-text msg-text hidden';
  stage.append(text, head, rows);
  const r = { text: '', reasoning: '', usage: null, agents: null, thoughtMs: 0, streaming: false, last: null, list: [], rows: [], sources: [], el: stage,
    parts: { text, head, line, acts, rows, sources: null } };
  line.addEventListener('click', () => toggleStage(b, r));
  b._rounds.push(r);
  b._parts.rows.appendChild(stage);
  return r;
}
// The live loop's round that showed nothing (discard): it goes. Returns the rounds left; the bubble's only round stays
// (0: the caller removes the bubble), unless the bubble has rows of the turn: then that round is emptied and the bubble
// stays with its rows (the turn's next answer reuses the round: nextRound).
function dropAssistantRound(b) {
  if (b && b._rounds && b._rounds.length === 1 && b._notes && b._notes.length) {
    Object.assign(b._rounds[0], { text: '', reasoning: '', usage: null, agents: null, thoughtMs: 0, workedMs: 0, streaming: false, last: null, calling: '', list: [] });
    paintBubble(b);
    return 1;
  }
  if (!b || !b._rounds || b._rounds.length <= 1) return 0;
  const r = b._rounds.pop();
  r.el.remove();
  paintBubble(b);
  return b._rounds.length;
}
const openStages = new Set(); // the open stages while the panel is open, keyed by their first call id
// ---- Decision and result cards in the bubble --------------------------------------------------------------------
// A card of gate.js (ask_user, the edit gate, open_document, the access card) raised by a call of the turn waits in the
// bubble's cards slot, under the answer: never inside a fold, so the question is in view whatever the user folded. Once
// decided, its answered row moves into the stage of the call's round, right after the call's row (settleRoundCard), and
// folds with the other rows. A call's result card (a paste's) goes there too, after the call's decision
// card; it never holds its stage open (Undo stays on the round's action row).
// A card of a call in a stage: a result card (.tool-card) or an answered decision's row (gate.js answerCard).
const CALL_CARD_SEL = '.tool-card, .answered-row';
const callCard = (n) => !!(n && n.classList && (n.classList.contains('tool-card') || n.classList.contains('answered-row')));
// The waiting card of call id (confirmOpen's ui.place): in the cards slot until it is decided. false: no bubble to hold
// it (the caller appends it to the chat).
function placeRoundCard(b, card, id) {
  if (!b || !b.isConnected || !b._parts) return false;
  card._callId = id;
  b._parts.cards.appendChild(card);
  paintBubble(b); // the cards slot shows
  return true;
}
// The decided card (confirmOpen's ui.settle, after answerCard): its answered row goes after its call's row (a call
// without a row keeps it in the cards slot).
function settleRoundCard(b, card) {
  if (!b || !b._parts || !card) return;
  placeAnsweredCard(b, card._callId, card);
  paintBubble(b);
}
// A card of call id (renderHistory: its answered and result cards; live: a decided card, a result card): after the
// row of the call and the cards already placed there. false: the call has no row in the bubble (a delegate call); the
// card then stays where it is (toolCard appended it at the end of the chat). A card after a row changes nothing else
// the bubble shows, so nothing is painted here.
function placeAnsweredCard(b, id, card) {
  if (!b || !b._rounds || !id) return false;
  for (const r of b._rounds) {
    const i = r.list.findIndex((a) => a && a.id === id);
    if (i < 0 || !r.rows[i]) continue;
    let at = r.rows[i];
    while (at.nextSibling && callCard(at.nextSibling)) at = at.nextSibling;
    at.after(card);
    return true;
  }
  return false;
}

const stageKey = (r) => { const a = r.list.find((x) => x && x.id); return a ? a.id : null; };
function stageOpen(r) {
  const key = stageKey(r);
  return key ? openStages.has(key) : !!r.open;
}
function toggleStage(b, r) {
  const key = stageKey(r);
  const open = !stageOpen(r);
  if (key) { if (open) openStages.add(key); else openStages.delete(key); } else r.open = open;
  paintBubble(b);
}
// The rounds whose text is in the answer slot: the rounds with text after the last round with tool calls of this panel
// (the final answer, with its continuation after a length cut; live, the reply that streams now). A round has calls once
// their rows are there (log entries) or its stream writes a call (calling): its text came before them, so from then on
// it stands in its stage, above its action row, in the place it had in the answer (sidepanel.css .stage.lead-text), and
// nothing moves when the row comes. A server's rows (a persona's or a web search's, no log) came before the text that
// answers them: that text stays the answer. [] for none: the last action row ends the bubble (a turn stopped after a
// round that spoke and called tools keeps that text above its row, where it arose).
// A delegate call has no row (its agent block stands apart), so its round's text stays where it is.
const hasCalls = (r) => r.list.some((a) => a && a.log) || (!!r.calling && !ownBlock(r.calling));
function headRounds(b) {
  const rs = b._rounds;
  let k = rs.length - 1;
  while (k >= 0 && !hasCalls(rs[k])) k--;
  const tail = [];
  for (let i = k + 1; i < rs.length; i++) if (String(rs[i].text || '').trim()) tail.push(i);
  return tail;
}
// The text round i shows: its own, '' when it repeats the text of the nearest earlier round that has one (a model in a
// loop says the same sentence before every call: it is drawn once, where it first arose; the stage keeps its row). While
// the round streams, a text that is still the start of that earlier one waits, so a repeat never flashes in and out.
const flatText = (t) => String(t || '').replace(/\s+/g, ' ').trim();
function roundText(b, i) {
  const rs = b._rounds;
  const t = flatText(rs[i].text);
  if (!t) return '';
  for (let j = i - 1; j >= 0; j--) {
    const p = flatText(rs[j].text);
    if (!p) continue;
    if (t === p || (rs[i].streaming && p.startsWith(t))) return '';
    break;
  }
  return String(rs[i].text);
}
// The answer slot's text: the head rounds' texts, joined by a blank line; the other rounds' texts are in their stages.
function answerText(b) {
  return headRounds(b).map((i) => roundText(b, i)).filter(Boolean).join('\n\n');
}
function syncStages(b) {
  const head = headRounds(b);
  const texts = b._rounds.map((r, i) => (head.includes(i) ? '' : roundText(b, i).trim()));
  const visible = b._rounds.map((r, i) => !!(r.list.length || texts[i] || r.parts.sources || r.parts.rows.querySelector(CALL_CARD_SEL)));
  b._rounds.forEach((r, i) => {
    const q = r.parts;
    r.el.classList.toggle('hidden', !visible[i]);
    if (q.text._src !== texts[i]) {
      q.text.innerHTML = texts[i] ? renderMarkdown(texts[i]).html : '';
      // Its code blocks keep their text, not the answer's Apply / Copy (their indexes point into the answer's codes).
      for (const btn of q.text.querySelectorAll('.code-bar button')) btn.remove();
      q.text._src = texts[i];
    }
    q.text.classList.toggle('hidden', !texts[i]);
    // The Sources follow the rows (web-search.js puts them before the text, which now leads the stage).
    if (q.sources && q.sources.parentNode === r.el && q.sources.previousSibling !== q.rows) q.rows.after(q.sources);
    // A round with its text alone: its dot sits on a line of message text, not on an action row.
    r.el.classList.toggle('text-only', visible[i] && !r.list.length && !q.sources && !!texts[i] && !q.rows.querySelector(CALL_CARD_SEL));
    // A round led by its text: the dot on the text's first line, the answer's gap above it (sidepanel.css).
    r.el.classList.toggle('lead-text', visible[i] && !!texts[i]);
    const lined = r.list.length >= 2;
    const open = lined && stageOpen(r);
    q.head.classList.toggle('hidden', !lined);
    q.line.setAttribute('aria-expanded', String(open));
    r.el.classList.toggle('open', open);
    q.rows.classList.toggle('hidden', lined && !open);
  });
  b._parts.activity.classList.toggle('hidden', !visible.some(Boolean) && !(b._notes && b._notes.length));
  syncToolGroup(b);
}
// The timeline rail (see addAssistantBubble): the shown items in their order (the rounds, the answer), the first and the
// last marked (the line runs from the first dot to the last; a lone item has its dot only) and the live item: the round
// whose call runs or whose card waits, else the answer while its text streams; between those the footer's orb is enough
// (the owner's choice: the footer is not an item). An ended bubble has no live item. The waiting cards line up with the
// items (.has-rail on the bubble).
function syncRail(b) {
  const p = b._parts;
  const all = [...p.rows.children, p.answer]; // the rounds' stages and the turn's rows, in their order
  const items = all.filter((n) => !n.classList.contains('hidden'));
  let live = null;
  if (b._live) {
    const waiting = new Set([...p.cards.children].map((c) => c._callId).filter(Boolean));
    const busy = (a) => a && ((a.log && a.status === 'pending') || (a.id && waiting.has(a.id)));
    const r = [...b._rounds].reverse().find((x) => !x.el.classList.contains('hidden') && x.list.some(busy));
    const cur = b._rounds[b._rounds.length - 1];
    live = r ? r.el : cur && cur.streaming && cur.last === 'text' && items.includes(p.answer) ? p.answer : null;
  }
  b.classList.toggle('has-rail', items.length > 0);
  const failed = new Set((b._rounds || []).filter((x) => x.list.some((a) => a && a.log && (a.status === 'fail' || a.status === 'rejected'))).map((x) => x.el));
  for (const n of all) {
    const item = items.includes(n);
    n.classList.toggle('tl-item', item);
    n.classList.toggle('tl-first', item && n === items[0]);
    n.classList.toggle('tl-last', item && n === items[items.length - 1]);
    n.classList.toggle('tl-live', item && n === live);
    n.classList.toggle('tl-fail', item && failed.has(n));
  }
}
// The row of entry a, drawn again at the next update (a running call's progress changed its summary; the rows are keyed
// by status and result only).
function staleActivityRow(b, a) {
  const row = b && b._rows ? b._rows.find((x) => x && x._src === a) : null;
  if (row) row._key = null;
}

// ---- The footer's status and the thinking orb (orb.js) ---------------------------------------------------------
// The orb's mode for a running call of this panel (or a server-side row): a search -> globe, a write -> rubik, its
// verifying re-read (the row's phase 'verifying') -> ring, anything else -> orbits. The re-read gets the ring, not a
// later moment of the rubik: a rubik cycle takes seconds (its bands click back into place only in its second half), a
// re-read well under one, so a rubik restarted for it would show only scrambling.
const ORB_SEARCH_RE = /search|find|scholar|openalex|arxiv|pubmed|literature/i;
function toolOrbMode(name, phase) {
  if (phase === 'verifying') return 'ring';
  const n = String(name || '');
  if (ORB_SEARCH_RE.test(n) && n !== 'find_reference') return 'globe';
  return isEditTool(n) && n !== ASK_USER_TOOL.function.name ? 'rubik' : 'orbits';
}

// The footer status's words besides a call's own text and the labels of an ended turn: nothing has arrived or nothing
// live shows; the reasoning streams; the answer text streams (the owner's word).
const WORKING_TEXT = 'Working…';
const THINKING_TEXT = 'Thinking…';
const WAITING_TEXT = 'Waiting…';
// The line of a running call: its location, else its pending text or its kind word (kindText), so the orb never stands
// without a word while a call runs.
const callText = (a) => placeText(a) || kindText(a.name, a.args);
// What the status at the left of the bubble's footer shows, from the bubble's model alone (the rounds, b._live, the
// waiting cards); the first rule that matches wins. While the turn runs: present tense with the orb, the footer never
// hidden; once it has ended: past tense, no orb, the marker when there is reasoning to open (below the footer's row).
//   live, a card waits on the user          the waiting call's line          wave
//   live, a call of this panel runs         its line (callText)              toolOrbMode(name, phase)
//   live, the stream writes a call          its kind word ("Reading…")       ring
//   live, a server-side row came last       its kind word ("Searching…")     toolOrbMode(name)
//   live, the reasoning streams             Thinking… (pulsing)              ring
//   live, the answer text streams           Waiting… (the typing cursor)     ring
//   live, anything else                     Working…                         ring
//   ended: "Stopped after Ns" (the user's Stop), "Worked for Ns" (tool calls), "Thought for Ns", "Thinking" (reasoning
//   stored without its time), else no status (the footer then holds the token line alone, or is hidden).
// Returns { text, orb, live, pulse, cursor } (text '': the status is hidden).
function bubbleStatus(b) {
  const rounds = b._rounds || [];
  if (b._live) {
    const cur = rounds[rounds.length - 1] || { list: [] };
    const now = (text, orb, more) => ({ text, orb, live: true, pulse: false, cursor: false, ...more });
    const pending = rounds.flatMap((r) => r.list).filter((a) => a && a.log && a.status === 'pending');
    const run = pending[pending.length - 1];
    if (pendingPreviews.size) return now(run ? callText(run) : WORKING_TEXT, 'wave');
    if (run) return now(callText(run), toolOrbMode(run.name, run.phase));
    if (cur.streaming) {
      const server = [...cur.list].reverse().find((a) => a && !a.log);
      if (cur.last === 'call' && cur.calling) return now(kindText(cur.calling), 'ring');
      if (cur.last === 'activity' && server) return now(kindText(server.name), toolOrbMode(server.name));
      if (cur.last === 'reasoning') return now(THINKING_TEXT, 'ring', { pulse: true });
      if (cur.last === 'text') return now(WAITING_TEXT, 'ring', { cursor: true });
    }
    return now(WORKING_TEXT, 'ring');
  }
  const worked = rounds.reduce((n, r) => Math.max(n, r.workedMs || 0), 0);
  const thought = rounds.reduce((n, r) => n + (r.thoughtMs || 0), 0);
  const reasoning = rounds.some((r) => r.reasoning);
  const text = worked > 0 && rounds.some((r) => r.stopped) ? stoppedLabel(worked) : worked > 0 ? workedLabel(worked)
    : reasoning ? (thought > 0 ? thoughtLabel(thought) : 'Thinking') : '';
  return { text, orb: null, live: false, pulse: false, cursor: false };
}

// The orb in the footer's summary, before the label: made once, never moved (orb.js ends its loop when it leaves the page).
function bubbleOrb(b) {
  if (!b._orb) {
    b._orb = orbCreate();
    b._parts.sum.insertBefore(b._orb, b._parts.label);
  }
  return b._orb;
}
let liveBubble = null; // the bubble of the running turn: repainted when a card starts or stops waiting (watchCards)
let turnOrb = null; // the last live mode of this turn's orb (a wave aside): the frozen frame after Stop or an error
function syncOrb(b, mode) {
  if (mode && b._live) turnOrb = mode === 'wave' ? turnOrb || 'ring' : mode;
  if (mode) bubbleOrb(b);
  if (!b._orb || b._orbMode === mode) return;
  b._orbMode = mode;
  orbSetState(b._orb, mode);
}
// gate.js announces every card that starts or stops waiting: the live bubble's orb waves while one does.
watchCards(() => { if (liveBubble && liveBubble._live && liveBubble.isConnected) paintBubble(liveBubble); });

// After an error inside a turn (addError while busy): the orb's last mode stays as one still frame in the footer of the
// turn's last bubble (after the final re-render, or the /side bubble once ended), or, when its status is hidden or the
// turn has no bubble, in the error row. A stopped turn keeps no frozen frame (the owner: the label and its arrow only):
// dropTurnOrb.
const dropTurnOrb = () => { turnOrb = null; };
function freezeTurnOrb(row) {
  if (!state.busy || !turnOrb) return;
  const mode = turnOrb;
  turnOrb = null;
  const all = [...el.chat.querySelectorAll('.msg.user, .msg.assistant')];
  const last = all[all.length - 1];
  const b = last && last.classList.contains('assistant') && last._parts && !last._parts.think.classList.contains('hidden') ? last : null;
  let c = null;
  if (b) { c = bubbleOrb(b); b._orbMode = null; } else if (row) { c = orbCreate(); row.insertBefore(c, row.firstChild); }
  if (c) orbSetState(c, mode, { frozen: true });
}

// ---- Where the agent works: the footer status of a running call ---------------------------------------------
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
// The location of a running call (a log entry: name, args, phase), or ''. While a write's re-read verifies it
// (phase 'verifying'): "Verifying the edit in Methods" (the heading of the write), else "Verifying the edit".
function placeText(a) {
  if (!a) return '';
  const own = !a.args || typeof a.args !== 'object' ? '' : a.phase === 'verifying' ? verifyingText(a) : writingText(a);
  return own || writeProgressText(a);
}
// The state words of the footer's status by the kind of a call: while the model writes the call (its name has arrived, its
// arguments stream) and while a call without a location of its own runs. One table, so the words are easy to change.
const KIND_WORDS = { read: 'Reading…', edit: 'Editing…', search: 'Searching…', ask: 'Asking…', delegate: 'Delegating…', check: 'Checking…' };
// Tools whose kind the rules below would get wrong (models list/check reads, check_references and guideline_coverage
// check, draft writes no document text, remember edits MAIN.md or DOC.md).
const NAMED_KINDS = { ask_user: 'ask', delegate: 'delegate', models: 'check', check_references: 'check', guideline_coverage: 'check', draft: null, remember: 'edit' };
// args: the parsed arguments of a running call, or undefined while they stream (a tool that only sometimes reads
// counts as reading then).
function toolKind(name, args) {
  const n = String(name || '');
  if (Object.prototype.hasOwnProperty.call(NAMED_KINDS, n)) return NAMED_KINDS[n];
  if (ORB_SEARCH_RE.test(n)) return 'search';
  if (isReadingTool({ function: { name: n, arguments: JSON.stringify(args && typeof args === 'object' ? args : {}) } })) return 'read';
  return isEditTool(n) ? 'edit' : null;
}
// The word for a call; an unknown kind reads "Working…".
const kindText = (name, args) => KIND_WORDS[toolKind(name, args)] || WORKING_TEXT;
// A running write without a location of its own (edit_document without operations, undo, a registered writing tool,
// replace_selection): its progress (a.progress, snap.onCallProgress) or its pending text ("Editing the document…").
// The progress of a write shows here and on the action row only, never as a card of its own.
function writeProgressText(a) {
  if (a.name === 'remember') return `Updating ${rememberFile(a.args)}…`; // a change of MAIN.md or DOC.md: the file is its place
  if (!isEditTool(a.name) || a.name === ASK_USER_TOOL.function.name) return ''; // ask_user: its card says it
  if (extraTool(a.name) && isReadingTool({ function: { name: a.name, arguments: typeof a.args === 'string' ? a.args : JSON.stringify(a.args || {}) } })) return '';
  return a.progress || pendingCardText(a.name, a.args) || 'Replacing the selection…';
}
const VERIFYING = 'Verifying the edit';
function verifyingText(a) {
  const { name, args } = a;
  const h = (n) => (n > 0 && isMainDocRef(args.doc) ? headingAbove(n) : '');
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const heading = name === 'replace_section' && typeof args.heading === 'string' ? oneLineClip(args.heading)
    : name === 'insert_after_line' && !(Array.isArray(args.inserts) && args.inserts.length) ? h(num(args.line))
    : (name === 'delete_lines' || name === 'format_lines') && !(Array.isArray(args.ranges) && args.ranges.length) ? h(num(args.start))
    : name === 'replace_text' || name === 'format_text' ? h(Number.isInteger(args.line) && args.line > 0 ? args.line : lineOfText(args.old_text)) : '';
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
    case 'read_document': {
      const sc = readScope(args.scope, args);
      const inc = readIncludes(args.include);
      const fmt = !!inc.set && inc.set.has('formatting');
      if (sc.error) return '';
      if (sc.kind === 'outline') return other ? 'Reading the outline of another document' : 'Reading the outline';
      if (sc.kind === 'all') return `Reading ${fmt ? 'the formatting of ' : ''}${other ? 'another document' : 'the document'}`;
      if (fmt) return `Reading the formatting of ${rangeText(sc.start, sc.end)}${other ? ' of another document' : ''}`;
      return `Reading ${rangeText(sc.start, sc.end)}${other ? ' of another document' : (headingAbove(num(sc.start)) ? ` in ${headingAbove(num(sc.start))}` : '')}`;
    }
    case 'read_lines': return `Reading ${rangeText(args.start, args.end)}${other ? ' of another document' : (headingAbove(num(args.start)) ? ` in ${headingAbove(num(args.start))}` : '')}`;
    case 'read_formatting': return `Reading the formatting of ${rangeText(args.start, args.end)}${other ? ' of another document' : ''}`;
    case 'find_in_document': return typeof args.query === 'string' ? `Searching ${other ? 'another document' : 'the document'} for "${oneLineClip(args.query)}"` : '';
    case 'get_outline': return other ? 'Reading the outline of another document' : 'Reading the outline';
    case 'insert_after_line': return Array.isArray(args.inserts) && args.inserts.length ? `Writing at ${args.inserts.length} places` : num(args.line) === 0 ? 'Writing at the beginning' : at(num(args.line), 'Writing', `after line ${num(args.line)}`);
    case 'delete_lines': return Array.isArray(args.ranges) && args.ranges.length ? `Deleting ${args.ranges.length} ranges` : at(num(args.start), 'Deleting', rangeText(args.start, args.end));
    case 'format_lines': return Array.isArray(args.ranges) && args.ranges.length ? `Formatting ${args.ranges.length} ranges` : at(num(args.start), 'Formatting', rangeText(args.start, args.end));
    case 'edit_document': return Array.isArray(args.operations) && args.operations.length ? `Writing ${args.operations.length} edit${args.operations.length === 1 ? '' : 's'}` : '';
    case 'replace_section': return typeof args.heading === 'string' ? `Writing in ${oneLineClip(args.heading)}` : '';
    case 'replace_all': return typeof args.old_text === 'string' ? `Replacing every "${oneLineClip(args.old_text)}"` : '';
    case 'replace_text': case 'format_text': {
      if (name === 'format_text' && args.all === true && typeof args.old_text === 'string') return `Formatting every "${oneLineClip(args.old_text)}"`;
      const n = Number.isInteger(args.line) && args.line > 0 ? args.line : lineOfText(args.old_text);
      return n ? at(n, name === 'replace_text' ? 'Writing' : 'Formatting', `line ${n}`) : '';
    }
    default: return '';
  }
}
const oneLineClip = (t) => { const s = String(t).replace(/\s+/g, ' ').trim(); return s.length > 40 ? s.slice(0, 40) + '…' : s; };
// ---- The agent block (agents.js: delegate) ------------------------------------------------------------------
// One chat element per agent, "agent: <label>": appended at the bottom of the chat when the agent starts (so the main
// model's later rounds render below it), with the orb left of the title, the round counter and a stop control while it
// runs; when it ends, the answer (Markdown; a long one folded to its first lines, Show all), the agent's tool calls
// (folded) and one meta line (status · rounds · tokens · provider/model). After a re-render: at the delegate call while
// the agent runs (agentStartBlock), then at its report message (renderHistory: _agentReport); a delegate result of an
// earlier build, which ran the agent inside the turn, at its call (agentBlockFor). No emoji: the label is the model's
// words. agentId: the agent's id (aN; _agentId on the element, which agents.js finds to show the progress).
const AGENT_FOLD_CHARS = 600;
const AGENT_FOLD_LINES = 8;
// access: the right while it runs ("read", "edit · lines 40–80": agents.js agentAccessText); the meta line has it after.
function agentBlockStart(label, agentId, access = '') {
  const d = document.createElement('div');
  d.className = 'msg agent-block running';
  const head = document.createElement('div');
  head.className = 'agent-head';
  const orb = orbCreate();
  const title = document.createElement('span');
  title.className = 'agent-title';
  title.textContent = `agent: ${label}`;
  const right = document.createElement('span');
  right.className = 'agent-access';
  right.textContent = access;
  const prog = document.createElement('span');
  prog.className = 'agent-progress';
  const stop = document.createElement('button');
  stop.className = 'btn small agent-stop';
  stop.type = 'button';
  stop.textContent = 'Stop';
  stop.dataset.tip = 'Stop the agent';
  stop.addEventListener('click', () => {
    stop.disabled = true;
    prog.textContent = 'stopping…';
    stopAgent(agentId);
  });
  head.append(orb, title, ...(access ? [right] : []), prog, stop);
  const cards = document.createElement('div'); // the cards of the agent's calls while it runs (placeAgentCard)
  cards.className = 'agent-cards hidden';
  d.append(head, cards);
  d._agentCards = cards;
  d._agentParts = { head, orb, title, right, prog, stop };
  d._agentId = agentId;
  if (d.dataset) d.dataset.agentId = agentId;
  markSide(d);
  appendToChat(d);
  orbSetState(orb, 'orbits');
  return d;
}
// The running agent's progress: { round, max } (a tool loop) or { searching, calls } (a Munin research request).
function agentBlockProgress(d, p) {
  const parts = d && d._agentParts;
  if (!parts || !p || parts.stop.disabled) return;
  const text = p.searching ? `searching${p.calls ? ` · ${p.calls} tool call${p.calls === 1 ? '' : 's'}` : ''}` : `round ${p.round} of ${p.max}`;
  if (parts.prog.textContent !== text) parts.prog.textContent = text;
}
// The finished block from the call's arguments and its tool message fields.
function agentBlockFinish(d, args, r) {
  const parts = d._agentParts;
  if (parts) { orbSetState(parts.orb, null); parts.orb.remove(); parts.right.remove(); parts.prog.remove(); parts.stop.remove(); }
  if (d._agentCards) { d._agentCards.remove(); d._agentCards = null; } // drawn again from the log, after their call's row
  const info = (r && r._agent) || {};
  const st = info.status || (r && r._ok ? 'ok' : 'error');
  d.className = `msg agent-block st-${st}`;
  const answer = info.full || agentReason(r);
  if (answer) {
    const body = document.createElement('div');
    body.className = 'agent-answer md';
    body.innerHTML = renderMarkdown(answer).html;
    d.appendChild(body);
    if (answer.length > AGENT_FOLD_CHARS || answer.split('\n').length > AGENT_FOLD_LINES) {
      body.classList.add('folded');
      const more = document.createElement('button');
      more.className = 'btn small ghost agent-more';
      more.type = 'button';
      more.textContent = 'Show all';
      more.addEventListener('click', () => { more.textContent = body.classList.toggle('folded') ? 'Show all' : 'Show less'; });
      d.appendChild(more);
    }
    d._text = answer; // Copy of the chat's handlers
  }
  const log = Array.isArray(info.log) ? info.log : [];
  if (log.length) {
    const det = document.createElement('details');
    det.className = 'agent-log';
    det.innerHTML = `<summary>${fmtNum(log.length)} tool call${log.length === 1 ? '' : 's'}</summary>`;
    for (const e of log) {
      const row = document.createElement('div');
      row.className = `activity-row ${e.status || ''}`.trim();
      row.innerHTML = `<span class="activity-name">${escapeHtml(e.name || 'tool')}</span>` +
        `${e.summary ? ': ' + escapeHtml(e.summary) : ''}${escapeHtml(LOG_STATUS[e.status] || '')}`;
      if (e.reason && e.status !== 'ok') row.dataset.tip = String(e.reason); // why it failed (a failed call has no card)
      det.appendChild(row);
      for (const c of agentLogCards(e)) det.appendChild(c);
    }
    d.appendChild(det);
  }
  const meta = document.createElement('div');
  meta.className = 'agent-meta';
  meta.textContent = agentMetaText(info, st);
  d.appendChild(meta);
  d._agentParts = null;
  return d;
}
// The block at a delegate call that started a background agent (_agentStart): running (with its progress and Stop)
// while this panel runs it; finished while its report waits for the next turn; nothing once the report is in the history
// (the block is drawn there); 'lost' when nobody runs it any more and no report came (the panel was reloaded).
const AGENT_LOST_TEXT = 'Agent status: lost\nThe panel was closed or reloaded while this agent ran, so its report was lost.';
function agentStartBlock(start, messages) {
  const id = start && start.id;
  if (!id || messages.some((m) => m && m._agentReport && m._agentReport.id === id)) return null;
  const live = agentLive(id);
  const d = agentBlockStart(start.label || '', id, agentAccessText(start));
  if (live.running) { agentBlockProgress(d, live.progress); keepAgentCards(d); return d; }
  if (live.pending) return agentBlockFinish(d, {}, live.pending);
  const e = live.entry;
  if (e && e.status === 'running') { // another tab runs it: no Stop here
    d._agentParts.stop.remove();
    d._agentParts.prog.textContent = 'running in another tab';
    d._agentParts = null;
    return d;
  }
  if (e && e.status !== 'lost') return agentBlockFinish(d, {}, { _ok: true, content: '', _agent: { status: e.status, full: e.full, log: e.log, usage: e.usage, rounds: e.rounds, access: e.access, scope: e.scope } });
  return agentBlockFinish(d, {}, { _ok: false, content: AGENT_LOST_TEXT, _agent: { status: 'lost' } });
}
// A stored delegate call of an earlier build drawn again (renderHistory).
function agentBlockFor(tc, r) {
  const { args } = parseToolArgs(tc);
  const d = agentBlockStart(agentLabel(args), tc.id);
  return agentBlockFinish(d, args, r || { _ok: false, content: 'Agent status: error\nNo result.' });
}
// What to show when the agent gave no answer: the result's sentence for the model, without its status line.
function agentReason(r) {
  if (!r || typeof r.content !== 'string') return '';
  return r.content.split('\n').slice(1).filter((l) => l !== AGENT_REPORT_NOTE).join('\n').trim();
}
const agentTokens = (u) => (u ? (Number(u.prompt_tokens) || 0) + (Number(u.completion_tokens) || 0) : 0);
// "ok · edit · lines 40–80 · 2 rounds · 8.1k tokens · munin/qwen3.8-27b" (refused: the status only).
function agentMetaText(info, st) {
  const out = [st];
  if (st !== 'refused' && info.provider) {
    const right = agentAccessText(info);
    if (right) out.push(right);
    out.push(info.search && !info.rounds ? 'search' : `${info.rounds || 0} round${info.rounds === 1 ? '' : 's'}`);
    if (info.usage) out.push(`${fmtTokensK(agentTokens(info.usage))} tokens`);
    out.push(`${info.provider}/${info.model}`);
  }
  if (info.unverified) out.push(`${info.unverified} unverified citation${info.unverified === 1 ? '' : 's'}`);
  return out.join(' · ');
}
// ---- An agent's cards in its block ------------------------------------------------------------------------------
// The cards an agent's loop raises (the edit gate, open_document, the access card; a paste's result card) are
// the agent's, never the main turn's: while it runs they sit in its block under the head, in call order (a waiting one
// is never folded away); when it ends they go after their call's row in the folded tool-call log, drawn from the log's
// entries (agentCardInfo), which a reload draws the same way. ref: { id, docId, chatId } of the agent: its block is
// looked up in the open chat only (agent ids are per document).
const agentRefOpen = (ref) => !!ref && (!ref.docId || ref.docId === state.docId) && (!ref.chatId || ref.chatId === state.chatId);
function agentBlockOf(ref) {
  if (!agentRefOpen(ref) || !el.chat) return null;
  return [...el.chat.children].find((c) => c && c._agentId === ref.id && c._agentParts && c._agentCards) || null;
}
// false: the block is not on the page (the caller shows a decision card at the end of the chat, drops a result card).
function placeAgentCard(ref, callId, card) {
  card._agentRef = ref;
  card._callId = callId;
  const d = agentBlockOf(ref);
  if (!d) return false;
  d._agentCards.appendChild(card);
  d._agentCards._agentRef = ref;
  d._agentCards.classList.remove('hidden');
  card._agentPlaced = true;
  return true;
}
// An agent's result card (a paste fallback's): in its block, else nowhere (an agent's results never had a card at the
// end of the chat). A failed call has no card: its row in the agent's log says so.
function placeAgentResultCard(ref, tc, r) {
  const c = agentCardInfo(tc, r).card;
  if (c) placeAgentCard(ref, tc.id, agentResultCard(c));
}
// What an agent's log entry keeps of a call's cards (agents.js agentLog; stored with the report): answered, its decided
// cards (_answered), and card, its result card as toolCardFor would draw it. Texts clipped: the log is stored.
const AGENT_CARD_CHARS = 600;
const agentCardClip = (t) => { const s = String(t == null ? '' : t); return s.length > AGENT_CARD_CHARS ? s.slice(0, AGENT_CARD_CHARS) + '…' : s; };
function agentCardInfo(tc, r) {
  const out = {};
  if (!r) return out;
  const name = tc && tc.function && tc.function.name;
  if (Array.isArray(r._answered) && r._answered.length) out.answered = r._answered.filter((a) => a && typeof a === 'object').map((a) => ({ ...a, text: agentCardClip(a.text) }));
  if (!r._ok) {
    if (r._message || r.content) out.reason = agentCardClip(r._message || r.content); // the failed row's tooltip
  } else if (!isReadingTool(tc) && !ownBlock(name) && !writeRowInfo(tc, r) && !decisionOnly(tc, r)) {
    const { args } = parseToolArgs(tc);
    const text = r._cardText !== undefined ? r._cardText : typeof args.text === 'string' ? args.text : '';
    out.card = { ok: true, message: agentCardClip(r._message || 'Replaced in document'), text: agentCardClip(text),
      detail: agentCardClip(r._detail || '') };
    if (r._cardLabel) out.card.label = String(r._cardLabel);
  }
  return out;
}
function agentResultCard(c) {
  return toolCard('ok', String(c.message || ''), String(c.text || ''), String(c.detail || ''), { label: c.label, detached: true });
}
// The cards of a stored log entry, in the order they were shown: the decided ones, then the result card. A successful
// remember of a log stored while remember had a card (with its Revert data) is a plain row now, like a new one; the
// failure card of a log stored before failures lost their cards is not drawn (its row says failed).
function agentLogCards(e) {
  const answered = Array.isArray(e.answered) ? e.answered.filter((a) => a && typeof a === 'object') : [];
  const card = e.card && typeof e.card === 'object' && e.card.ok && e.name !== 'remember' ? e.card : null;
  return [...answered.map((a) => answeredCard({ ...a, text: String(a.text || ''), tool: String(a.tool || e.name || '') })),
    ...(card ? [agentResultCard(card)] : [])];
}
// A re-render while an agent runs (renderHistory): its cards, answered and waiting, move to its block drawn again.
let keptAgentCards = new Map();
function keepAgentCards(d) {
  const kept = keptAgentCards.get(d._agentId);
  if (!kept || !d._agentCards) return;
  keptAgentCards.delete(d._agentId);
  d._agentCards.replaceWith(kept);
  d._agentCards = kept;
}

// The tool calls that get their own block instead of an action-log row or a card.
const ownBlock = (name) => { const t = extraTool(name); return !!(t && t.ownBlock); };

// ---- Edit blocks of the read-only chat turns ------------------------------------------------------------------
// The read-only turns' rules (TOOLS_MANUAL_RULES: /side, and the Manual mode of earlier builds, whose answers stored
// chats keep) ask for an edit as <replacement>…</replacement> (the new text of the selection) or
// <insertion>…</insertion> (text for the cursor). A finished answer with exactly one well-formed block
// shows it as a labeled card whose bar holds the only Insert / Copy pair, which paste or copy exactly the block;
// anything else renders as plain Markdown (the tags stay visible as text). History keeps the raw answer.
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
// The state of a log row in words, in the row's colour (a failed or refused row's round has a red dot: syncRail); no emoji.
const LOG_STATUS = { pending: ' …', fail: ' · failed', rejected: ' · rejected', ok: '' };

// One row of the activity area: an expandable log row (tool call of this panel: summary line, then the
// full arguments and the result text), a pending row (call still running), a plain persona row, or the row of a
// successful document write (writeRow).
function activityRow(a) {
  const name = escapeHtml(a.name || 'tool');
  const line = `<span class="activity-name">${name}</span>${a.summary ? ': ' + escapeHtml(a.summary) : ''}`;
  const title = (a.name || 'tool') + (a.summary ? ': ' + a.summary : '');
  if (a.log && a.status === 'ok' && a.write) return writeRow(a);
  if (!a.log || a.status === 'pending') {
    const row = document.createElement('div');
    row.className = 'activity-row' + (a.log ? ' log-row pending' : '');
    row.innerHTML = line + (a.log ? escapeHtml(LOG_STATUS.pending) : '');
    row.dataset.tip = title;
    return row;
  }
  const row = document.createElement('details');
  row.className = 'activity-row log-row ' + a.status;
  row.innerHTML = `<summary data-tip="${escapeHtml(title)}">${line}${escapeHtml(LOG_STATUS[a.status] || '')}</summary><div class="log-body">` +
    logDetailsHtml(a) + '</div>';
  return row;
}
// The arguments and the exact result text of a log row's fold.
function logDetailsHtml(a) {
  const args = formatToolArgs(a.args);
  const res = a.result == null ? '' : a.result;
  // A result replaced by a stub after its turn (slimHistory): its original size.
  const size = a.omitted ? `omitted, was ${fmtNum(a.omitted)} characters` : `${fmtNum(res.length)} character${res.length === 1 ? '' : 's'}`;
  return (args ? `<div class="log-label">Arguments</div><pre>${escapeHtml(clipLog(args))}</pre>` : '') +
    `<div class="log-label">Result (${size})</div><pre>${escapeHtml(clipLog(res)) || '(empty)'}</pre>` +
    (a.detail ? `<div class="log-detail">${escapeHtml(clipLog(a.detail))}</div>` : '');
}

// The row of a successful document write: it stands in for the write's card (the owner's choice: one thing per write).
// One line in the neutral row colour, "<tool> · Done · <preview of the text>" ("Undone" once undone), that opens on a
// click to what the card's body showed (what was done, the text or "What changed", the detail) and the log's arguments
// and result; Undo (and Undo all) at its right end, outside the fold, while the edit is the most recent undoable one.
function writeRow(a) {
  const w = a.write;
  const row = document.createElement('div');
  row.className = 'activity-row log-row ok write-row' + (w.undone ? ' undone' : '');
  const undo = w.undone ? '' : rowUndoHtml(w.editId);
  const acts = undo ? `<span class="row-acts">${undo}</span>` : '';
  const word = w.undone ? 'Undone' : 'Done';
  // An undo that left something to know (lost objects, a re-created list): that is the undone row's preview.
  const preview = w.undone && w.undoNote ? w.undoNote
    : w.preview != null ? String(w.preview) : cardPreview(w.text || (w.diff && w.diff.newText) || w.detail) || a.summary || '';
  const title = `${a.name || 'tool'} · ${w.message}${w.undone ? ' (undone)' : ''}`;
  const body = `<div class="log-what">${escapeHtml(w.message)}</div>` + (w.detail ? `<div class="log-detail">${escapeHtml(w.detail)}</div>` : '') +
    (w.undoText && !w.undone ? `<div class="log-detail log-undo">${escapeHtml(w.undoText)}</div>` : '') +
    (w.undone && w.undoNote ? `<div class="log-detail log-undo">${escapeHtml(w.undoNote)}</div>` : '') +
    (w.diff ? `<div class="log-label">What changed</div><div class="word-diff">${wordDiffHtml(wordDiff(w.diff.oldText, w.diff.newText))}</div>`
      : w.text ? `<div class="log-label">${escapeHtml(w.label || 'Inserted text')}</div><pre class="log-text">${escapeHtml(w.text)}</pre>` : '') +
    (w.noLog ? '' : logDetailsHtml(a));
  row.innerHTML = `<details class="log-fold"><summary data-tip="${escapeHtml(title)}"><span class="activity-name">${escapeHtml(a.name || 'tool')}</span>` +
    ` · <span class="log-status">${word}</span>${preview ? `<span class="log-preview"> · ${escapeHtml(preview)}</span>` : ''}</summary>` +
    `<div class="log-body">${body}</div></details>${acts}`;
  row._entry = a;
  if (w.editId) editCards.set(w.editId, row); // an undo inside the turn (refreshEditCard) redraws it
  return row;
}
// Undo (and Undo all) of a row, as small arrow controls (the owner's choice: words were noise on the row; the tooltip and
// the accessible name say what they do, the count only there), while editId is the most recent undoable edit; else ''.
function rowUndoHtml(editId) {
  const latest = latestUndoable();
  if (!editId || !state.googleConnected || !latest || latest._edit.id !== editId) return '';
  const many = answerEdits(editId).length; // "Undo all": the answer made 2+ undoable edits
  const all = `Undo all ${many} edits`;
  return `<button class="row-act" type="button" data-act="undo-edit" data-edit="${escapeHtml(editId)}" data-tip="Undo this edit" aria-label="Undo this edit">↶</button>` +
    (many >= 2 ? `<button class="row-act" type="button" data-act="undo-all" data-edit="${escapeHtml(editId)}" data-tip="${all}" aria-label="${all}">⟲</button>` : '');
}
const activityKey = (a) => (a.log ? `${a.status}|${a.result == null ? '' : a.result.length}${a.write && a.write.undone ? '|undone' : ''}` : 'plain|' + (a.summary || ''));

// Brings a round's activity rows in line with its list: new entries are appended, entries whose state changed (a call
// finished) replace their row. Rows only: paintBubble syncs the stages and their action rows once, after all rounds.
function renderActivity(b, r) {
  r.list.forEach((a, i) => {
    const key = activityKey(a || {});
    const old = r.rows[i];
    if (old && old._key === key) { old._src = a; return; }
    const row = activityRow(a || {});
    row._key = key;
    row._src = a;
    if (old) old.replaceWith(row); else r.parts.rows.appendChild(row);
    r.rows[i] = row;
  });
  for (const extra of r.rows.splice(r.list.length)) extra.remove();
}

// ---- The action row of a round with two or more calls (the owner's choice: the single rows were noise) ----
// "Actions 3" (no tool names on the row; the running call's place is the footer's status below), "· Undone" when an edit
// of the round was undone, "· failed" when a call failed (its row is folded away with the others). The names in call
// order, repeats counted ("get_outline, read_lines ×2"), are the row's tooltip. A click (Enter, Space) opens the round's
// rows (toggleStage, openStages). The Undo (and Undo all) of the round's edit that is the most recent undoable one sits
// at its right end (rowUndoHtml shows nothing for the others, so only the last edited round carries it). A round with
// one call has no such row: its call's row is the action row. syncStages calls it; an undo inside the turn too
// (docs-undo.js refreshEditCard).
// The names part: "get_outline, read_lines ×2, replace_text ×2".
function toolGroupNames(list) {
  const counts = new Map();
  for (const a of list) { const n = (a && a.name) || 'tool'; counts.set(n, (counts.get(n) || 0) + 1); }
  return [...counts].map(([n, k]) => (k > 1 ? `${n} ×${k}` : n)).join(', ');
}
// "· failed" marks a failed call whose row is folded away with the others ("failed (2)" for two).
function toolGroupText(list, entries) {
  const undone = entries.filter((a) => a && a.write && a.write.undone).length;
  const failed = entries.filter((a) => a && a.status === 'fail').length;
  const count = (word, n) => (n ? ` · ${word}${n > 1 ? ` (${n})` : ''}` : '');
  return `Actions ${list.length}${count('Undone', undone)}${count('failed', failed)}`;
}
function syncToolGroup(b) {
  for (const r of b._rounds || []) {
    if (r.list.length < 2) continue;
    const q = r.parts;
    // The drawn rows' entries: an undo inside the turn (refreshEditCard) marks the row's own entry undone.
    const entries = r.list.map((a, i) => (r.rows[i] && r.rows[i]._entry) || a);
    const text = toolGroupText(r.list, entries);
    if (q.line.textContent !== text) q.line.textContent = text;
    const names = toolGroupNames(r.list);
    if (q.line.dataset.tip !== names) q.line.dataset.tip = names;
    let acts = '';
    for (let i = entries.length - 1; i >= 0 && !acts; i--) {
      const w = entries[i] && entries[i].write;
      if (w && w.editId && !w.undone) acts = rowUndoHtml(w.editId);
    }
    if (q.acts.innerHTML !== acts) q.acts.innerHTML = acts;
  }
}

// Updates the bubble's last round (a new round: startAssistantRound first) and paints the whole bubble.
// streaming: the round's stream is open; last: what it delivered last (the stream hooks; see bubbleStatus).
// agents: the _agent records of this round's delegate results (their tokens go into the meta line separately).
// thoughtMs: how long this round's reasoning took (the label "Thought for Ns"; stored as _thoughtMs).
// workedMs: set on the last round of a finished turn that made tool calls (stored as _workedMs): the label then reads
// "Worked for Ns"; with stopped (the user's Stop, stored as _stopped) "Stopped after Ns".
// calling: the name of the tool call the stream is writing (its arguments not complete yet): the footer status's kind word.
function updateAssistantBubble(b, { text = '', reasoning = '', streaming = false, last = null, usage = null, activity = null, agents = null, thoughtMs = 0, workedMs = 0, stopped = false, calling = '' } = {}) {
  const r = b._rounds[b._rounds.length - 1];
  Object.assign(r, { text: text || '', reasoning: reasoning || '', streaming: !!streaming, last: last || null, usage: usage || null, agents: Array.isArray(agents) ? agents : null,
    thoughtMs: Number(thoughtMs) > 0 ? Number(thoughtMs) : 0, workedMs: Number(workedMs) > 0 ? Number(workedMs) : 0,
    stopped: !!stopped, calling: typeof calling === 'string' ? calling : '', list: Array.isArray(activity) ? activity : [] });
  paintBubble(b);
}
// The end of the turn on a bubble that is not drawn again from a history (/side; a stopped turn's label-only bubble;
// renderHistory's last round with nothing else to show): past tense, the meta line, no orb. workedMs > 0: "Worked for
// Ns" on it, or "Stopped after Ns" (stopped). runSideTurn calls it on every way out, so no bubble stays live.
function endAssistantBubble(b, { workedMs = 0, stopped = false } = {}) {
  if (!b || !b._rounds || !b._rounds.length) return;
  b._live = false;
  if (liveBubble === b) liveBubble = null;
  for (const r of b._rounds) r.streaming = false;
  if (Number(workedMs) > 0) Object.assign(b._rounds[b._rounds.length - 1], { workedMs: Number(workedMs), stopped: !!stopped });
  paintBubble(b);
}
// "Thought for 3s" / "Worked for 2m 5s": whole seconds (at least 1); from 60 s on minutes and seconds ("2m" when the
// seconds are zero), so a long turn reads at a glance.
function secondsText(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), rest = s % 60;
  if (m < 60) return rest ? `${m}m ${rest}s` : `${m}m`;
  const h = Math.floor(m / 60), mm = m % 60; // an hour or more: no seconds
  return mm ? `${h}h ${mm}m` : `${h}h`;
}
const thoughtLabel = (ms) => `Thought for ${secondsText(ms)}`;
const workedLabel = (ms) => `Worked for ${secondsText(ms)}`;
const stoppedLabel = (ms) => `Stopped after ${secondsText(ms)}`;
// The turn's usage: the rounds' numbers summed (total_tokens only from the rounds that report it).
function turnUsage(rounds) {
  const us = rounds.map((r) => r.usage).filter(Boolean);
  if (!us.length) return null;
  const sum = (k) => us.reduce((n, u) => n + (Number(u[k]) || 0), 0);
  const totals = us.filter((u) => Number.isFinite(Number(u.total_tokens)));
  const out = { prompt_tokens: sum('prompt_tokens'), completion_tokens: sum('completion_tokens'), cache_read_input_tokens: sum('cache_read_input_tokens'),
    reasoning_tokens: sum('reasoning_tokens'), web_search_requests: sum('web_search_requests') };
  if (totals.length) out.total_tokens = totals.reduce((n, u) => n + Number(u.total_tokens), 0);
  return out;
}
// The reasoning below the footer's row shows while its details is open and has a status and reasoning to open.
function syncThinkingBody(think, body) {
  const c = think.classList;
  body.classList.toggle('hidden', !think.open || c.contains('hidden') || c.contains('no-body'));
}
// The reader is at the end of the chat (scrollToBottom's distance): the live bubble's growth then stays in view.
const CHAT_END_PX = 80;
const atChatEnd = () => !!el.chat && el.chat.scrollHeight - el.chat.scrollTop - el.chat.clientHeight < CHAT_END_PX;
// Draws the whole bubble from its model, slot by slot (their order never changes): the rows, the stages with their
// action rows, the answer, the cards slot, the footer: the status (bubbleStatus) with its orb and the reasoning, and the
// token line. A live bubble keeps the end of the chat in view when the reader was there before the paint (a new row, a
// card, the footer's next line); a reader who scrolled up is left where they are.
function paintBubble(b) {
  const follow = !!b._live && b.isConnected && atChatEnd();
  paintBubbleParts(b);
  if (follow) el.chat.scrollTop = el.chat.scrollHeight;
}
function paintBubbleParts(b) {
  const p = b._parts;
  const rounds = b._rounds;
  if (b._live) liveBubble = b;
  for (const r of rounds) renderActivity(b, r);
  b._list = rounds.flatMap((x) => x.list);
  b._rows = rounds.flatMap((x) => x.rows);
  syncStages(b);
  const reasoning = rounds.map((r) => r.reasoning).filter(Boolean).join('\n\n');
  const st = bubbleStatus(b);
  p.think.classList.toggle('hidden', !st.text);
  p.think.classList.toggle('live', st.live); // the orb stands where the marker is
  p.think.classList.toggle('pulse', st.pulse);
  p.think.classList.toggle('no-body', !reasoning);
  if (reasoning && b._reasoning !== reasoning) { p.body.textContent = reasoning; b._reasoning = reasoning; }
  if (p.label.textContent !== st.text) p.label.textContent = st.text;
  syncThinkingBody(p.think, p.body);
  syncOrb(b, st.orb);
  const text = answerText(b);
  if (b._text !== text || b._mdLive !== b._live) {
    const { html, codes, blockIdx } = renderAnswer(text, b._live); // an edit block only in a finished answer
    p.md.innerHTML = html;
    b._codes = codes;
    b._text = text;
    b._mdLive = b._live;
    if (b._blockIdx !== blockIdx) { // another shape of answer: a Plan answer's Do it (planActions) goes until drawn again
      p.extra.innerHTML = '';
      p.extra.classList.add('hidden');
      b._blockIdx = blockIdx;
    }
  }
  const shown = !!text && !b._reviewCard; // a /review answer shows review.js's card in the answer's place
  p.md.classList.toggle('hidden', !shown);
  p.answer.classList.toggle('hidden', !shown);
  b.classList.toggle('typing', st.cursor);
  p.cards.classList.toggle('hidden', !p.cards.children.length);
  syncRail(b);
  const usage = turnUsage(rounds);
  const total = usage && Number.isFinite(Number(usage.total_tokens)) ? Number(usage.total_tokens) : null;
  const ag = rounds.flatMap((r) => r.agents || []).filter((a) => a && a.usage);
  const agTok = ag.reduce((n, a) => n + agentTokens(a.usage), 0);
  if ((total != null || agTok > 0) && !b._live) {
    // The line shows what the turn's requests cost without the cached prefix (the owner's choice); the tooltip keeps the
    // whole breakdown. The agents' tokens are their own sessions: shown apart, never added to the requests' size.
    const cached = usage && Number(usage.cache_read_input_tokens) > 0 ? Math.min(Number(usage.cache_read_input_tokens), total || 0) : 0;
    p.meta.textContent = [total != null ? `${fmtNum(total - cached)} tokens` : '', agTok ? `agents ${fmtTokensK(agTok)}` : ''].filter(Boolean).join(' · ');
    const extra = [];
    if (cached) extra.push(`Cached: ${fmtNum(cached)}`, `Total: ${fmtNum(total)}`);
    if (usage && usage.reasoning_tokens) extra.push(`Reasoning: ${fmtNum(usage.reasoning_tokens)}`);
    if (usage && usage.web_search_requests) extra.push(`Web searches: ${fmtNum(usage.web_search_requests)}`);
    if (agTok) {
      const sum = (k) => ag.reduce((n, a) => n + (Number(a.usage[k]) || 0), 0);
      extra.push(`Agents: ${fmtNum(agTok)} (prompt ${fmtNum(sum('prompt_tokens'))}, completion ${fmtNum(sum('completion_tokens'))})`);
    }
    const counted = rounds.filter((r) => r.usage).length;
    if (counted > 1) extra.push(`${counted} requests`);
    p.meta.dataset.tip = [...(usage ? [`Prompt: ${fmtNum(usage.prompt_tokens || 0)}`, `Completion: ${fmtNum(usage.completion_tokens || 0)}`] : []), ...extra].join(' · ');
    p.meta.classList.remove('hidden');
  } else {
    p.meta.classList.add('hidden');
  }
  // The footer: always there while the turn runs; once ended, while it has the time or the tokens to show.
  p.foot.classList.toggle('hidden', !st.live && !st.text && p.meta.classList.contains('hidden'));
}

// The status mark of a card or row: a small coloured dot (CSS .mk), its state named for screen readers and the
// tooltip. No emoji anywhere in cards and rows: the colour and the words carry the state.
const MARK_LABELS = { ok: 'Done', fail: 'Failed', pending: 'Working', undone: 'Undone', warn: 'Warning', skip: 'Skipped', note: 'Note', rejected: 'Refused' };
const markHtml = (st, label) => `<span class="mk ${st}" role="img" aria-label="${escapeHtml(label || MARK_LABELS[st] || st)}" data-tip="${escapeHtml(label || MARK_LABELS[st] || st)}"></span>`;
// The one line of a card: the mark and the title (pending cards and revise.js's progress text use it too).
const cardLineHtml = (st, title) => `<div class="tc-line">${markHtml(st)}<span class="tc-title">${escapeHtml(title)}</span></div>`;
// The folded line's preview of the text involved: one line, at most CARD_PREVIEW_CHARS characters.
const CARD_PREVIEW_CHARS = 60;
function cardPreview(t) {
  const s = String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
  return s.length > CARD_PREVIEW_CHARS ? s.slice(0, CARD_PREVIEW_CHARS).trimEnd() + '…' : s;
}

// Card of a document edit. opts: label (the heading of the text in the body, default "Inserted text"),
// editId (journaled edit: an Undo button while it is the most recent undoable one), undone (the edit was undone
// later), diff ({ oldText, newText } of an applied
// replacement: "What changed" by words in place of the text; a record of the edit, not a preview), detached (not
// appended to the chat: the caller places it).
// A successful card is one line, the status and a clipped preview of the text, that opens to the body on a click;
// Undo sits on that line, so it stays one click away. A failed or pending card shows everything at once:
// its reason must be readable without a click. Icons of tools and results (_icon) are not shown.
function toolCard(status, message, text, detail, opts = {}) {
  const d = document.createElement('div');
  const st = status === 'ok' ? (opts.undone ? 'undone' : 'ok') : status === 'fail' ? 'fail' : 'pending';
  d.className = 'tool-card ' + (status === 'ok' ? 'ok' : status === 'fail' ? 'fail' : 'pending') + (opts.undone ? ' undone' : '');
  const title = status === 'ok' ? (message || 'Replaced in document') + (opts.undone ? ' (undone)' : '')
    : status === 'fail' ? (message || 'Replacement failed')
      : (message || 'Replacing the selection in the document…');
  const latest = latestUndoable();
  const canUndo = opts.editId && !opts.undone && state.googleConnected && latest && latest._edit.id === opts.editId;
  const many = canUndo ? answerEdits(opts.editId).length : 0; // "Undo all": the answer made 2+ undoable edits
  const undoAll = many >= 2
    ? `<button class="btn small" type="button" data-act="undo-all" data-edit="${escapeHtml(opts.editId)}" data-tip="Undo all ${many} edits">Undo all (${many})</button>`
    : '';
  const undo = canUndo
    ? `<button class="btn small" type="button" data-act="undo-edit" data-edit="${escapeHtml(opts.editId)}" data-tip="Undo this edit">Undo</button>${undoAll}`
    : '';
  const actions = undo ? `<div class="tool-actions">${undo}</div>` : '';
  const detailHtml = detail ? `<div class="detail">${escapeHtml(detail)}</div>` : '';
  if (status === 'ok') {
    const body = detailHtml + (opts.diff ? `<div class="what-changed"><div class="tc-label">What changed</div><div class="word-diff">${wordDiffHtml(wordDiff(opts.diff.oldText, opts.diff.newText))}</div></div>`
      : text ? `<div class="tc-text"><div class="tc-label">${escapeHtml(opts.label || 'Inserted text')}</div><pre>${escapeHtml(text)}</pre></div>` : '');
    const preview = cardPreview(text || (opts.diff && opts.diff.newText) || detail);
    const line = `${markHtml(st)}<span class="tc-title">${escapeHtml(title)}</span>${preview ? `<span class="tc-preview">${escapeHtml(preview)}</span>` : ''}`;
    d.innerHTML = `<div class="tc-row">${body
      ? `<details class="tc-fold"><summary class="tc-line" data-tip="Show what changed">${line}</summary><div class="tc-body">${body}</div></details>`
      : `<div class="tc-line">${line}</div>`}${actions}</div>`;
  } else {
    d.innerHTML = `<div class="tc-row">${cardLineHtml(st, title)}${actions}</div>` + detailHtml +
      (text ? `<details><summary>${escapeHtml(opts.label || 'Inserted text')}</summary><pre>${escapeHtml(text)}</pre></details>` : '');
  }
  if (!opts.detached) appendToChat(d);
  if (opts.editId) editCards.set(opts.editId, d);
  return d;
}

// Card for a finished editing tool call (replace_selection, the Docs API writing tools, undo). A successful write has
// no card, its action-log row shows it (writeRowInfo); a failed call or one without a result has none either (the
// owner's choice: its failed row and the row's fold are the record): an empty fragment.
function toolCardFor(tc, r) {
  const { args } = parseToolArgs(tc);
  if (!r || !r._ok || writeRowInfo(tc, r) || decisionOnly(tc, r)) return document.createDocumentFragment();
  const text = r._cardText !== undefined ? r._cardText : typeof args.text === 'string' ? args.text : '';
  return toolCard('ok', r._message || 'Replaced in document', text, r._detail,
    { label: r._cardLabel, diff: editDiff(tc, args, r), editId: r._edit ? r._edit.id : null, undone: !!(r._edit && r._edit.undone) });
}

// A result the answered decision card says all of (answeredCardsFor): an ask_user answer (chosen or stopped; in the
// chat in a chat stored with the removed "I'll answer in chat" button), a denied or stopped edit or open_document. No second card under it.
function decisionOnly(tc, r) {
  const name = tc && tc.function && tc.function.name;
  if (!r || !r._decision) return false;
  return name === ASK_USER_TOOL.function.name || r._decision === 'rejected' || r._decision === 'stopped';
}

// The answered decision cards of a stored tool call (renderHistory): its _answered entries; for a chat stored before
// them, the ask_user answer and a denied or stopped edit are rebuilt from _decision (an allowed edit of such a chat
// shows its row only, as it did).
function answeredCardsFor(tc, r) {
  if (!r) return [];
  const name = tc && tc.function && tc.function.name;
  let list = Array.isArray(r._answered) ? r._answered.filter((a) => a && typeof a === 'object') : [];
  if (!list.length && name === ASK_USER_TOOL.function.name && r._decision) {
    const choice = r._decision === 'answered' ? String(r._message || '').replace(/^(You chose|Chosen): ?/, '') : '';
    list = [{ kind: 'ask', tool: name, title: 'Question', text: String(r._detail || ''),
      decision: r._decision === 'answered' ? 'option' : r._decision === 'chat' ? 'chat' : 'stop', choice }];
  } else if (!list.length && (r._decision === 'rejected' || r._decision === 'stopped') && name !== 'open_document') {
    list = [{ kind: 'edit', tool: name, title: 'Allow this edit?', text: '', decision: r._decision === 'stopped' ? 'stop' : 'reject' }];
  }
  return list.map((a) => answeredCard({ ...a, text: String(a.text || ''), tool: String(a.tool || name || '') }));
}

// What the row of a successful document write shows (writeRow), or null when the call keeps its card or its plain row:
// a failure or refusal, a reading call, ask_user, delegate (its block). The paste result (replace_selection) and
// remember (a change of MAIN.md or DOC.md) count as writes.
function writeRowInfo(tc, r) {
  const name = tc && tc.function && tc.function.name;
  if (!r || r._ok !== true || !name) return null;
  if (name === 'remember') return rememberRowInfo(tc, r);
  if (name === ASK_USER_TOOL.function.name || ownBlock(name) || !isEditTool(name) || isReadingTool(tc) || r._reading) return null;
  const { args } = parseToolArgs(tc);
  const text = r._cardText !== undefined ? r._cardText : typeof args.text === 'string' ? args.text : '';
  return { message: r._message || 'Done', text: String(text || ''), detail: r._detail ? String(r._detail) : '', label: r._cardLabel,
    diff: editDiff(tc, args, r), editId: r._edit ? r._edit.id : null, undone: !!(r._edit && r._edit.undone),
    undoNote: r._edit && r._edit.undone && r._edit.undoNote ? String(r._edit.undoNote) : '' };
}
// A successful remember: the rule as the row's preview; its fold names the file and scope and the action, and shows
// the rule (a replaced line: what changed). From the result's _remember, else the call's arguments (a rule that was
// already there changed nothing and has none). A stored reverted flag of the removed Revert button is ignored.
// The row's preview names the file and the change ("DOC.md: added «rule»"), like a write's preview names its text.
function rememberRowInfo(tc, r) {
  const { args } = parseToolArgs(tc);
  const ch = r._remember && typeof r._remember === 'object' ? r._remember : args;
  const scope = ch.scope === 'main' ? 'main' : 'document';
  const action = ['add', 'remove', 'replace'].includes(ch.action) ? ch.action : '';
  const text = String(ch.text == null ? '' : ch.text);
  const old = action === 'replace' && typeof ch.old === 'string' && ch.old !== text ? ch.old : '';
  const where = `${scope === 'main' ? 'MAIN.md' : 'DOC.md'} (scope ${scope})${action ? `, action ${action}` : ''}`;
  const preview = r._remember && typeof r._remember === 'object' ? rememberLine(ch, true) : `${rememberFile(ch)}: unchanged «${oneLine(text, 60)}»`;
  // Its journal entry (_edit, kind 'remember'): Undo on the row like any write's; the fold says what an undo does.
  const e = r._edit && r._edit.kind === 'remember' ? r._edit : null;
  return { message: r._message || 'Done', text, detail: where, label: action === 'remove' ? 'Removed rule' : 'Rule',
    diff: old ? { oldText: old, newText: text } : null, editId: e ? e.id : null, undone: !!(e && e.undone), preview,
    undoText: e && !e.undone ? `Undo ${rememberUndoText(e)}.` : '' };
}
const rememberFile = (ch) => (ch && ch.scope === 'main' ? 'MAIN.md' : 'DOC.md');
const REMEMBER_VERBS = { add: ['add', 'added'], remove: ['remove', 'removed'], replace: ['replace', 'replaced'] };
// A remember call in one line: "DOC.md: add «rule»" (the call: its running and failed rows), "MAIN.md: removed «rule»"
// (done: the row's preview), "DOC.md: replaced «old» → «new»".
function rememberLine(ch, done = false) {
  const c = ch && typeof ch === 'object' ? ch : {};
  const text = String(c.text == null ? '' : c.text);
  const verb = REMEMBER_VERBS[c.action];
  const old = c.action === 'replace' && typeof c.old === 'string' && c.old && c.old !== text ? `«${oneLine(c.old, 30)}» → ` : '';
  return `${rememberFile(c)}: ${verb ? verb[done ? 1 : 0] + ' ' : ''}${old}«${oneLine(text, old ? 30 : 60)}»`;
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

// The footer status of a running write without a location of its own (writeProgressText), remember's too; no call has a
// pending card.
const REMEMBER_PENDING = 'Updating the instructions…';
// A registered tool's pending may depend on the call's arguments (models: switch or settings).
const extraPending = (t, args) => (typeof t.pending === 'function' ? t.pending(typeof args === 'string' ? parseToolArgs({ function: { arguments: args } }).args : args || {}) : t.pending);
const pendingCardText = (name, args) => (name === REPLACE_TOOL.function.name ? '' : name === 'undo_last_edit' ? 'Undoing the last edit…'
  : name === 'remember' ? REMEMBER_PENDING : (extraTool(name) && extraPending(extraTool(name), args)) || 'Editing the document…');
// A registered tool (registerTools) counts as a write (its success is a row, its failure a card) unless it is always
// a reading tool (a tool whose calls only sometimes read counts; its reading calls stay plain log rows).
const isEditTool = (name) => name === REPLACE_TOOL.function.name || WRITE_TOOLS.includes(name) ||
  (!!extraTool(name) && extraTool(name).reading !== true && !extraTool(name).ownBlock); // delegate: its own block

// What other modules put back into the chat after renderHistory cleared it (doc-init.js: the DOC.md pass's row).
const chatRedrawHooks = [];
const onChatRedraw = (fn) => { chatRedrawHooks.push(fn); };
function runChatRedraw() {
  for (const fn of chatRedrawHooks) { try { fn(); } catch (e) { /* best effort */ } }
}

function renderEmpty() {
  // One neutral line (dimmed); no other onboarding text.
  el.chat.innerHTML = '<div class="empty">Ask about the document or say what to change.</div>';
}

// Parses tool-call arguments; returns { args, error, repaired? } (error: the raw text when it is no JSON object). Weak
// models send the object as a JSON string inside JSON, wrapped in a code fence, or with trailing commas: those are
// repaired (repaired: true; runToolCall then stores the clean JSON, which servers parse in the history).
function parseToolArgs(tc) {
  const raw = (tc && tc.function && tc.function.arguments) || '';
  if (!raw.trim()) return { args: {}, error: null };
  const tryParse = (t) => { try { return { v: JSON.parse(t) }; } catch (e) { return null; } };
  const lenient = (t) => tryParse(t) || tryParse(t.replace(/,(\s*[}\]])/g, '$1')); // trailing commas
  const direct = tryParse(raw);
  const fence = /^\s*```[a-zA-Z]*\s*\n?([\s\S]*?)\n?\s*```\s*$/.exec(raw);
  let p = direct || lenient(fence ? fence[1] : raw);
  if (p && typeof p.v === 'string' && p.v.trim()) p = lenient(p.v.trim()); // a string that holds the object
  if (p && p.v === null) return { args: {}, error: null };
  if (!p || !p.v || typeof p.v !== 'object' || Array.isArray(p.v)) return { args: {}, error: raw };
  return { args: p.v, error: null, ...(p === direct ? {} : { repaired: true }) };
}

// The divider row of a compaction boundary, expandable to the text that replaced the messages above it
// (plain text, escaped): "Earlier conversation summarized · N messages" for a summary written by the
// model, "Earlier conversation condensed · N messages" for a fold (_folded: built without a request).
function addSummaryDivider(m) {
  const d = document.createElement('details');
  const folded = !!m._folded;
  d.className = folded ? 'summary-divider folded' : 'summary-divider';
  d.dataset.tip = folded ? 'What the model now gets' : 'The model\'s summary';
  const n = Number(m._covers) || 0;
  let text = String(m.content || '').replace(SUMMARY_PREFIX_RE, '');
  if (folded) text = text.replace(FOLD_NOTE, ''); // the fold's note on its format is for the model
  text = text.trim();
  d.innerHTML = `<summary>Earlier conversation ${folded ? 'condensed' : 'summarized'} · ${fmtNum(n)} message${n === 1 ? '' : 's'}</summary><div class="summary-text">${escapeHtml(text)}</div>`;
  return appendToChat(d, false);
}

// The stored automatic continuation (a user-role message with _auto, see toolLoop) is a row of its turn (not a user
// bubble), live and from the history alike. A revert after a pick in the model menu (_revert, accounts.js
// revertChatModel) is such a row too, with its own text (the model gets m.content). The wrap-up and the nudge requests
// (_autoKind) live only while their turn runs (settleAutoKinds) and have no row.
function autoRowText(m) {
  const r = m && m._revert;
  if (r) return `${r.from} did not answer. Back on ${r.to}.`; // r.error: the log's, no code in the chat
  if (m && m._failed) return FAILED_TURN_ROW; // a turn that failed before an answer (turn.js noteFailedTurn)
  return m && m._auto && !m._autoKind ? AUTO_CONTINUE_NOTICE : '';
}
const AUTO_ROW_TIP = 'Sent by the panel';
// The live row of a stored _auto message m (toolLoop, revertChatModel): its own message is the record.
function addAutoRow(m) {
  const text = autoRowText(m);
  return text ? addTurnRow(text, { store: false, tip: m._revert ? '' : AUTO_ROW_TIP }) : false;
}
// The live row of call id in bubble b drawn again from its stored result (a switch result rewritten by a revert).
function refreshCallRow(b, id, messages) {
  if (!b || !b._rounds) return;
  const tc = messages.flatMap((m) => (m && m.role === 'assistant' && m.tool_calls) || []).find((c) => c && c.id === id);
  const res = messages.find((m) => m && m.role === 'tool' && m.tool_call_id === id);
  if (!tc || !res) return;
  for (const r of b._rounds) {
    const i = r.list.findIndex((a) => a && a.id === id);
    if (i >= 0) { r.list[i] = logEntry(tc, res); paintBubble(b); return; }
  }
}

// Re-render that keeps what is shown but not stored (renderHistory drops it): the errors, the /check and /test reports and
// the rows outside a turn (addChatRow). Used after a compaction at the start of a turn and when another tab changed
// the chat; the turn's own rows are stored and drawn again.
function renderHistoryKeepingUnstored() {
  const keep = [...el.chat.children].filter((n) => n && n.classList && ['error', 'report', 'chat-row'].some((k) => n.classList.contains(k)));
  renderHistory();
  for (const n of keep) el.chat.appendChild(n);
}

// The side exchange of this chat, put back at the end after a re-render.
function keepSideBubbles() {
  for (const b of sideBubbles) appendToChat(b, false);
}

// A Plan answer's button: Do it when it is the latest message of the chat (doPlanFromButton in turn.js).
function planActions(b, latest) {
  const p = b._parts;
  p.extra.innerHTML = latest ? '<button class="btn small primary plan-do" type="button" data-act="plan-do" data-tip="Carry it out in Auto">Do it</button>' : '';
  p.extra.classList.toggle('hidden', !latest);
  b._blockIdx = -1; // a later update of this bubble rebuilds the buttons
}

// Full chat re-render from the history.
// A stopped turn that has no bubble of its own (nothing arrived, or only an agent's block): the Thinking label alone,
// "Stopped after Ns", so the chat shows that the turn was stopped.
function stoppedTurnBubble(m, dim) {
  const b = dim(addAssistantBubble());
  endAssistantBubble(b, { workedMs: m._workedMs, stopped: true });
  return { bubble: b };
}
// The chat renderHistory drew last ("docId:chatId"): drawn again (the end of a turn, the chat followed after a save, an
// undo), a reader who scrolled up keeps the place (the content above it is drawn the same); another chat, a reload or
// a reader at the end shows the end of the chat.
let renderedChat = null;
function renderHistory() {
  const chat = `${state.docId}:${state.chatId}`;
  const keepTop = renderedChat === chat && !atChatEnd() ? el.chat.scrollTop : null;
  renderedChat = chat;
  // A running agent's cards go to its block drawn again (agentStartBlock, keepAgentCards).
  keptAgentCards = new Map();
  for (const c of [...el.chat.children]) {
    if (c && c._agentParts && c._agentCards && c._agentCards.children.length && agentRefOpen(c._agentCards._agentRef)) keptAgentCards.set(c._agentId, c._agentCards);
  }
  el.chat.innerHTML = '';
  editCards.clear();
  syncSideThread();
  if (!state.messages.length) { renderEmpty(); keepSideBubbles(); runChatRedraw(); renderContextGauge(); return; }
  const results = new Map();
  for (const m of state.messages) if (m.role === 'tool') results.set(m.tool_call_id, m);
  // One bubble per turn: the assistant messages from a user message to the next one (the panel's own requests, _auto,
  // do not end a turn) are the rounds of one bubble, the answered decision cards and the result cards in their stages;
  // agent blocks and the rows of automatic continuations follow it, as they do live.
  let turn = null; // { bubble }
  const last = state.messages[state.messages.length - 1];
  for (const m of state.messages) {
    // Messages replaced by a summary are shown as before, slightly dimmed.
    const dim = (n) => { if (n && m._compacted) n.classList.add('compacted'); return n; };
    if (m.role === 'user' && (!m._auto || m._agentReport || m._summary)) turn = null; // an agent's report starts its own turn
    if (m.role === 'user' && m._summary) {
      dim(addSummaryDivider(m));
    } else if (m.role === 'user' && m._agentReport) {
      // An agent's report (agents.js): its block, not a user bubble.
      dim(agentBlockFinish(agentBlockStart(m._agentReport.label || '', m._agentReport.id), {}, m));
    } else if (m.role === 'user' && m._auto) {
      const text = autoRowText(m); // a row of its turn's bubble (a bubble of rows when the turn has none yet)
      if (text) {
        if (!turn || !turn.bubble.isConnected) turn = { bubble: dim(rowsBubble()) };
        drawTurnRow(turn.bubble, text, { tip: m._revert ? '' : AUTO_ROW_TIP });
      }
    } else if (m.role === 'user') {
      if (m.content.trim()) dim(userBubble(m.content, m._persona, m._files));
    } else if (m.role === 'tool' && Array.isArray(m._sources) && m._sources.length && turn && turn.bubble.isConnected) {
      renderSources(turn.bubble, m._sources); // links of a client search (munin-search.js): in its call's round
    } else if (m.role === 'assistant') {
      const text = m.content || '';
      // Munin persona tool activity (plain rows) plus the action log of the round's tool calls.
      const activity = [...(Array.isArray(m._toolActivity) ? m._toolActivity : []), ...actionLogFromToolCalls(m.tool_calls, results)];
      const agents = (m.tool_calls || []).map((tc) => results.get(tc.id)).filter((r) => r && r._agent).map((r) => r._agent);
      if (text.trim() || m._reasoning || activity.length) {
        if (turn && turn.bubble.isConnected) nextRound(turn.bubble); // a bubble that held only rows so far: its round
        else turn = { bubble: addAssistantBubble() };
        const b = dim(turn.bubble);
        updateAssistantBubble(b, { text, reasoning: m._reasoning || '', usage: m._usage || null, activity, agents, thoughtMs: m._thoughtMs || 0, workedMs: m._workedMs || 0, stopped: !!m._stopped });
        if (Array.isArray(m._sources) && m._sources.length) renderSources(b, m._sources); // the round's own sources
        if (m._plan) planActions(b, m === state.messages[state.messages.length - 1]);
      } else if (m._workedMs && turn && turn.bubble.isConnected) endAssistantBubble(turn.bubble, { workedMs: m._workedMs, stopped: !!m._stopped }); // a last round with nothing to show
      else if (m._workedMs && m._stopped) turn = stoppedTurnBubble(m, dim);
      for (const tc of m.tool_calls || []) {
        // Its decided cards: in the bubble after the call's row, as they were shown live (else after the bubble).
        for (const c of answeredCardsFor(tc, results.get(tc.id))) if (!placeAnsweredCard(turn && turn.bubble, tc.id, dim(c))) appendToChat(c, false);
        if (isReadingTool(tc)) continue; // in the action log only
        if (ownBlock(tc.function && tc.function.name)) {
          const r = results.get(tc.id);
          if (r && r._agentStart) { const b = agentStartBlock(r._agentStart, state.messages); if (b) dim(b); } else dim(agentBlockFor(tc, r));
          continue;
        }
        if (writeRowInfo(tc, results.get(tc.id))) continue; // a successful write: its action-log row only
        const card = toolCardFor(tc, results.get(tc.id)); // after its call's row (and decision card), as live
        if (card.nodeType !== 11) placeAnsweredCard(turn && turn.bubble, tc.id, dim(card));
      }
    }
    if (m.role === 'user' && m._stopped && m._workedMs && !m._summary) turn = stoppedTurnBubble(m, dim); // stopped before any reply
    // The turn's own rows stored on this message (addTurnRow): after its round, in the turn's bubble.
    if (Array.isArray(m._notes) && m._notes.length && !m._summary) {
      if (!turn || !turn.bubble.isConnected) turn = { bubble: dim(rowsBubble()) };
      for (const n of m._notes) drawTurnRow(turn.bubble, n, { latest: m === last });
    }
  }
  keptAgentCards = new Map();
  // A permission card still waiting for a decision (only possible if something re-renders mid-turn)
  // stays usable: an agent's goes back into its block, any other at the end.
  for (const p of pendingPreviews.values()) if (!(p.card._agentRef && placeAgentCard(p.card._agentRef, p.card._callId, p.card))) el.chat.appendChild(p.card);
  keepSideBubbles();
  runChatRedraw();
  if (keepTop != null) el.chat.scrollTop = keepTop; else scrollToBottom(true);
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
// and Anthropic, the hard budget for Munin). warn: the measured or estimated size is near compactAt, or on a provider
// with a prompt cache near the request's hard budget (tokenBudget): its compactAt is a cost choice far below the window
// (the history is compacted in the background), so a tint there would warn of a limit that is not one.
function contextGauge() {
  const active = activeHistory(state.messages);
  if (lastUserIndex(active) < 0) return null;
  const prov = activeProvider();
  const mode = applyTurnMode();
  const compactAt = compactionBudget(mode, { prov });
  const warnAt = cachesPrompt(prov) ? tokenBudget(mode, { prov }) : compactAt;
  const estimate = nextRequestEstimate(mode, active);
  const usage = latestMeasuredUsage(active);
  const prompt = usage ? Number(usage.prompt_tokens) : 0;
  const reply = usage ? Number(usage.completion_tokens) || 0 : 0;
  const used = usage ? prompt + reply : estimate;
  return { used, measured: !!usage, prompt, reply, estimate, window: prov.contextTokens, compactAt, label: prov.label,
    warn: Math.max(used, estimate) >= GAUGE_WARN_RATIO * warnAt };
}

// The open chat's model next to the gauge ("gpt-6-astra"; the tooltip names the type and the account when it has its own
// name, and the health: a red dot with the reason while down, a green one once verified): the button of the model menu
// (accounts.js). "Choose a model" while the chat has no account. Shown before the first request as well; it follows
// every change through renderContextGauge, and so do the settings rows' dropdowns (settings.js syncRowModels).
function renderChatModel() {
  const label = $('chatModel');
  if (!label) return;
  let a = null;
  let model = '';
  try { a = chatAccount(); model = a ? String(activeConfig().model || '') : ''; syncRowModels(); } catch (e) { /* settings not loaded */ }
  // The button has the mode button's dot and label spans (sidepanel.html); the label span carries the ellipsis.
  const text = label.querySelector('.mode-label');
  if (text) text.textContent = a ? model : 'Choose a model';
  else label.textContent = a ? model : 'Choose a model';
  label.classList.toggle('none', !a);
  label.classList.toggle('down', healthState(a) === 'down');
  label.classList.toggle('ok', healthState(a) === 'ok');
  if (!a) { label.dataset.tip = 'No model: choose one'; return; }
  const prov = PROVIDERS[a.type];
  label.dataset.tip = `${prov.label}${a.name !== typeName(a.type) ? ` (${a.name})` : ''} · ${model}${healthState(a) ? `\n${healthTitle(a)}` : ''}`;
}

function renderContextGauge() {
  renderChatModel();
  const box = $('contextGauge');
  if (!box) return;
  let g = null;
  try { g = contextGauge(); } catch (e) { g = null; }
  box.classList.toggle('hidden', !g);
  if (!g) return;
  const pct = (n) => `${Math.min(100, Math.max(0, (n / g.window) * 100)).toFixed(1)}%`;
  $('contextFill').style.width = pct(g.used);
  $('contextMark').style.left = pct(g.compactAt);
  $('contextText').textContent = `${g.measured ? '' : '~'}${fmtTokensK(g.used)} / ${fmtTokensK(g.window)}`; // used / window; the tooltip explains
  // role="img" hides the children from screen readers, so the label carries the numbers.
  box.setAttribute('aria-label', `Context: ${g.measured ? '' : 'about '}${fmtNum(g.used)} of ${fmtNum(g.window)} tokens${g.measured ? '' : ' (estimated)'}`);
  box.classList.toggle('warn', g.warn);
  box.classList.toggle('estimated', !g.measured);
  box.dataset.tip = [
    g.measured
      ? `Last request: ${fmtNum(g.used)} tokens (prompt ${fmtNum(g.prompt)} + reply ${fmtNum(g.reply)})`
      : `Next request: about ${fmtNum(g.used)} tokens`,
    `${g.label} window: ${fmtNum(g.window)} tokens`,
    `Compacted above ${fmtNum(g.compactAt)} tokens` + (g.measured ? ` (next: about ${fmtNum(g.estimate)})` : ''),
  ].join('\n');
}
