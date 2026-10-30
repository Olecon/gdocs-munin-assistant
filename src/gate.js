'use strict';
// Module gate.js: the permission gates: Allow / Deny cards (confirmOpen) and their button handler
// (decidePreview) for open_document, for large or risky edits (gateEdit) and for Undo all (kind 'undo-all'), the ask_user
// question card (askUser, kind 'ask'), the access card (kind 'access', references.js), and the attention dot on the
// collapsed panel's round button while a card waits (notifyAttention), and the read-first beforeWrite check
// (readFirstCheck, noteSeenLines).
/* global appendToChat, ASK_AGAIN_TEXT, docLines, isMainDocRef, READ_FIRST_EDGE_LINES, READ_FIRST_LINE_CHARS, registerTurnHook, showText, beforeWriteChecks, ASK_CHAT_TEXT, ASK_MAX_OPTIONS, ASK_STOPPED_TEXT, EDIT_DENIED_TEXT, EDIT_STOPPED_TEXT, EDIT_TOOL_ICONS, escapeHtml, extraIcon, extraTool, fmtNum, GATE_DELETE_LINES, GATE_FORMAT_LINES,
   GATE_REPLACE_ALL_COUNT, GATE_REPLACE_CHARS, HOST_TAB_ID, oneLine, READING_TOOL_ICONS, renderSelection, scrollToBottom,
   setStatus, state */
/* exported pendingPreviews, askUser, confirmOpen, confirmYourTurn, decidePreview, gateEdit, showYourTurnSelection, noteSeenLines */

// ---------------------------------------------------------------------------
// Permission gates: Allow / Deny cards
// ---------------------------------------------------------------------------
// Opening a document the user did not name, and a large or risky edit, waits for permission: the tool
// call pauses, an Allow / Deny card is shown, and the tool result goes back to the model only after the
// decision. Card data (plain text only; escaped when rendered):
//   { tool: 'open_document', title, kind: 'open', url, authuser?, mainAuthuser? }
//   { tool: <write tool>, title, kind: 'edit', why, range, excerptLabel, excerpt }
//   { tool: 'Undo all', title, kind: 'undo-all', icon, why, items: [{ title, mark, note }], confirm } (docs-undo.js
//     undoAllCard; buttons: confirm, which resolves 'accept' (none when confirm is null), and Cancel: 'reject')
//   { tool: 'ask_user', title, kind: 'ask', icon, question, options: [string] } (askUser; one button per option,
//     which resolves 'option:<index>', and "I'll answer in chat": 'chat')
//   { tool, title, kind: 'access', icon, text, onAllow } (requestReferencesAccess, references.js; Allow calls onAllow()
//     inside the click, since chrome.permissions.request needs the user gesture, and resolves 'accept' when its promise
//     gives true, 'refused' otherwise; Not now: 'reject')
function previewBodyHtml(pv) {
  if (pv.kind === 'ask') return `<div class="pv-note">${escapeHtml(pv.question)}</div>`;
  if (pv.kind === 'access') return `<div class="pv-note">${escapeHtml(pv.text)}</div>`;
  if (pv.kind === 'undo-all') {
    return `<div class="pv-note">${escapeHtml(pv.why)}</div>` + pv.items.map((it) => `<div class="pv-line">${escapeHtml(it.mark + ' ' + it.title)}</div>` +
      (it.note ? `<div class="pv-note">${escapeHtml(it.note)}</div>` : '')).join('');
  }
  if (pv.kind === 'edit') {
    return `<div class="pv-note">${escapeHtml(pv.why)}</div>` +
      (pv.range ? `<div class="pv-anchor">${escapeHtml(pv.range)}</div>` : '') +
      (pv.excerpt ? `<div class="pv-anchor">${escapeHtml(pv.excerptLabel)}</div><div class="pv-line pv-excerpt">${escapeHtml(pv.excerpt)}</div>` : '');
  }
  return '<div class="pv-anchor">The assistant wants to read this document and send its text to the AI provider:</div>' +
    `<div class="pv-line">${escapeHtml(pv.url)}</div>` +
    (pv.authuser !== undefined ? `<div class="pv-anchor">Google account index ${escapeHtml(pv.authuser == null ? 'default' : pv.authuser)} ` +
      `(the main document uses ${escapeHtml(pv.mainAuthuser == null ? 'the default' : pv.mainAuthuser)})</div>` : '');
}

const previewHead = (pv) => `<div class="pv-head">${escapeHtml(pv.icon || EDIT_TOOL_ICONS[pv.tool] || READING_TOOL_ICONS[pv.tool] || extraIcon(pv.tool) || '✏️')} <span class="pv-tool">${escapeHtml(pv.tool)}</span> · ${escapeHtml(pv.title)}</div>`;

// ---- Waiting for the decision -----------------------------------------------------------------------
// Pending permission cards (card id -> { card, decide }). The buttons resolve them through the chat's
// click handler (decidePreview); the turn's abort signal (Stop) resolves them with 'stop'. Chats cannot
// be switched while a turn runs, and collapsing the panel only hides it, so a pending card always ends
// with a click or with Stop.
const pendingPreviews = new Map();
let previewSeq = 0;
// Button tooltips per card kind: Allow, Deny, Allow all in this turn.
const BUTTON_TIPS = {
  open: ['Let the assistant read this document', 'Do not open it; the assistant is told you did not allow it', 'Allow this and the other documents the assistant opens in this answer'],
  edit: ['Apply this edit to the document', 'Do not apply it; the assistant is told you did not allow it', 'Allow this and the other checked edits of this answer'],
  'undo-all': ['Undo these edits now, newest first', 'Close this card; nothing is undone'],
  ask: ['Answer with this option', 'Type your answer in the chat instead; the assistant finishes what it can and stops'],
  access: ['Chrome asks once; you can remove the access later in chrome://extensions', 'Do not look anything up now'],
};

// Tells the Docs tab whether a card is waiting (content.js puts a dot on the collapsed panel's round
// button while one is). The tab: the turn's pinned document tab, else the host tab. Best effort.
function notifyAttention() {
  const tabId = state.pinnedTabId != null ? state.pinnedTabId : HOST_TAB_ID;
  if (tabId == null) return;
  try {
    const p = chrome.tabs.sendMessage(tabId, { type: 'ATTENTION', pending: pendingPreviews.size > 0 });
    if (p && p.catch) p.catch(() => {});
  } catch (e) { /* no tab / extension reloaded */ }
}

// Keeps a shown card pending (entry: its pendingPreviews fields besides decide) until it is decided: by a button
// (decidePreview), by Stop (signal: 'stop') or by the caller. done(decision) runs once; the attention dot follows
// the pending cards. Returns decide.
function holdCard(id, entry, signal, done) {
  const onAbort = () => decide('stop');
  function decide(decision) {
    if (!pendingPreviews.has(id)) return;
    pendingPreviews.delete(id);
    notifyAttention();
    if (signal) signal.removeEventListener('abort', onAbort);
    done(decision);
  }
  pendingPreviews.set(id, { ...entry, decide });
  notifyAttention();
  if (signal) signal.addEventListener('abort', onAbort);
  return decide;
}

// Shows the permission card (in place of ui.card, the pending card of the tool call, when there is one)
// and resolves with 'accept' | 'accept-all' | 'reject' | 'stop' (an access card also 'refused': Chrome did not grant). ui.card is set to the permission card,
// which the tool loop later removes.
function confirmOpen(preview, signal, ui = {}) {
  if (signal && signal.aborted) return Promise.resolve('stop');
  return new Promise((resolve) => {
    const id = 'pv' + (++previewSeq);
    const card = document.createElement('div');
    card.className = 'tool-card preview' + (preview.kind === 'ask' ? ' ask' : preview.kind === 'access' ? ' access' : '');
    const [allowTip, denyTip, allTip] = BUTTON_TIPS[preview.kind] || BUTTON_TIPS.open;
    card.innerHTML = previewHead(preview) + `<div class="pv-body">${previewBodyHtml(preview)}</div>` +
      '<div class="tool-actions pv-actions">' + (preview.kind === 'ask' ? askButtons(preview, id) : preview.kind === 'access' ? accessButtons(id) : preview.kind === 'undo-all' ? undoAllButtons(preview, id) :
      `<button class="btn small primary" type="button" data-act="preview-accept" data-preview="${id}" title="${allowTip}">Allow</button>` +
      `<button class="btn small" type="button" data-act="preview-reject" data-preview="${id}" title="${denyTip}">Deny</button>` +
      `<button class="btn small ghost" type="button" data-act="preview-accept-all" data-preview="${id}" title="${allTip}">Allow all in this turn</button>`) +
      '</div>';
    appendToChat(card, false);
    if (ui.card && ui.card !== card && ui.card.isConnected) ui.card.replaceWith(card);
    ui.card = card;
    scrollToBottom(true);
    const decide = holdCard(id, { card }, signal, (decision) => {
      card.classList.add('decided'); // hides the buttons until the card is removed
      resolve(decision);
    });
    // The answer buttons of an ask card are handled here (the chat's click handler knows only the data-act ones).
    if (preview.kind === 'ask') {
      card.addEventListener('click', (ev) => {
        const b = ev.target && ev.target.closest ? ev.target.closest('button[data-ask]') : null;
        if (b) decide(b.dataset.ask === 'chat' ? 'chat' : 'option:' + b.dataset.ask);
      });
    }
    if (preview.kind === 'access') card.addEventListener('click', (ev) => accessClick(ev, card, preview, decide));
    setStatus(preview.kind === 'ask' ? 'Waiting for your answer…' : 'Waiting for your decision…');
  });
}

// The buttons of an ask card: one per option, then "I'll answer in chat".
function askButtons(preview, id) {
  const [optionTip, chatTip] = BUTTON_TIPS.ask;
  return preview.options.map((o, i) => `<button class="btn small${i ? '' : ' primary'}" type="button" data-ask="${i}" data-preview="${id}" title="${optionTip}">${escapeHtml(o)}</button>`).join('') +
    `<button class="btn small ghost" type="button" data-ask="chat" data-preview="${id}" title="${chatTip}">I'll answer in chat</button>`;
}

// The buttons of an access card (data-access, handled by the card itself: Allow must call chrome.permissions.request
// in the click).
function accessButtons(id) {
  const [allowTip, laterTip] = BUTTON_TIPS.access;
  return `<button class="btn small primary" type="button" data-access="allow" data-preview="${id}" title="${allowTip}">Allow</button>` +
    `<button class="btn small" type="button" data-access="later" data-preview="${id}" title="${laterTip}">Not now</button>`;
}
function accessClick(ev, card, preview, decide) {
  const b = ev.target && ev.target.closest ? ev.target.closest('button[data-access]') : null;
  if (!b || b.disabled) return;
  if (b.dataset.access !== 'allow') { decide('reject'); return; }
  for (const x of card.querySelectorAll('button[data-access]')) x.disabled = true;
  let p;
  try { p = preview.onAllow(); } catch (e) { p = false; } // synchronously, inside the click
  Promise.resolve(p).then((ok) => decide(ok ? 'accept' : 'refused'), () => decide('refused'));
}

// ---------------------------------------------------------------------------
// ask_user: a choice that blocks the model
// ---------------------------------------------------------------------------
// askUser({question, options}, snap, ui) returns the tool message fields. Not a document edit and not a gate:
// no journal, no Allow / Deny; the card (kind 'ask') waits for one of the options, "I'll answer in chat" or
// Stop. One question per turn (snap.askedUser): a second call is refused, so a small model cannot loop on
// questions. A quiet tool loop (the self-test) has nobody to answer: refused. ui.decision ('answered' |
// 'chat' | 'stopped') becomes _decision.
const ASK_TEXT_CHARS = 300;
const ASK_OPTION_CHARS = 80;
async function askUser(args, snap, ui = {}) {
  const fail = (content, message) => ({ content, _ok: false, _message: message, _icon: '❓', _cardText: '' });
  if (snap.quiet) return fail('Error: ask_user is not available here; decide yourself and say what you assumed.', 'Not available here');
  if (snap.askedUser) return fail(ASK_AGAIN_TEXT, 'Only one question per answer');
  const question = typeof args.question === 'string' ? oneLine(args.question.trim(), ASK_TEXT_CHARS) : '';
  const options = Array.isArray(args.options) ? args.options.filter((o) => typeof o === 'string' && o.trim()).map((o) => oneLine(o.trim(), ASK_OPTION_CHARS)) : [];
  if (!question || options.length < 2 || options.length > ASK_MAX_OPTIONS || new Set(options).size !== options.length) {
    return fail(`Error: ask_user needs a question and 2 to ${ASK_MAX_OPTIONS} different, non-empty options.`, 'Invalid question');
  }
  snap.askedUser = true;
  const d = await confirmOpen({ tool: 'ask_user', title: 'Question', kind: 'ask', icon: '❓', question, options }, snap.signal, ui);
  const base = { _icon: '❓', _cardText: '', _detail: question };
  const m = /^option:(\d+)$/.exec(d);
  if (m && options[Number(m[1])] !== undefined) {
    const choice = options[Number(m[1])];
    ui.decision = 'answered';
    return { ...base, content: `The user chose: ${choice}.`, _ok: true, _message: `You chose: ${choice}` };
  }
  if (d === 'chat') {
    ui.decision = 'chat';
    return { ...base, content: ASK_CHAT_TEXT, _ok: true, _message: 'You will answer in the chat' };
  }
  ui.decision = 'stopped';
  return { ...base, content: ASK_STOPPED_TEXT, _ok: false, _message: 'Question not answered: stopped' };
}

// The two buttons of an Undo all card (no "all in this turn": it is not part of a turn); without preview.confirm
// (nothing would be undone) only Close.
function undoAllButtons(preview, id) {
  const [okTip, cancelTip] = BUTTON_TIPS['undo-all'];
  return (preview.confirm ? `<button class="btn small primary" type="button" data-act="preview-accept" data-preview="${id}" title="${okTip}">${escapeHtml(preview.confirm)}</button>` : '') +
    `<button class="btn small" type="button" data-act="preview-reject" data-preview="${id}" title="${cancelTip}">${preview.confirm ? 'Cancel' : 'Close'}</button>`;
}

// The self-test's "Your turn" card: an instruction for the user (plain text) with Continue and Skip, built
// like a permission card and decided through the same map and button handler (decidePreview; data-act
// "preview-continue" / "preview-skip"). Resolves with 'continue' | 'skip' | 'stop' (the signal: Stop) |
// 'timeout' (after opts.timeoutMs, when set). The card is removed once decided; the attention dot shows while
// it waits. opts.showSelection: the card also shows what the panel sees selected (yourTurnSeesText), kept up to
// date by the document's SELECTION_UPDATE (onRuntimeMessage → showYourTurnSelection); for the steps that ask
// the user to select text.
function confirmYourTurn(text, signal, { timeoutMs = 0, showSelection = false } = {}) {
  if (signal && signal.aborted) return Promise.resolve('stop');
  return new Promise((resolve) => {
    const id = 'pv' + (++previewSeq);
    const card = document.createElement('div');
    card.className = 'tool-card preview your-turn';
    card.innerHTML = '<div class="pv-head">🙋 <span class="pv-tool">Your turn</span> · self-test</div>' +
      `<div class="pv-body"><div class="pv-note">${escapeHtml(text)}</div></div>` +
      '<div class="tool-actions pv-actions">' +
      `<button class="btn small primary" type="button" data-act="preview-continue" data-preview="${id}" title="Done: let the self-test check the document">Continue</button>` +
      `<button class="btn small" type="button" data-act="preview-skip" data-preview="${id}" title="Skip this step">Skip</button>` +
      '</div>';
    let sees = null;
    if (showSelection) {
      // The selection pushed while the panel was busy (state.pendingSelection) is the latest the panel knows:
      // the Selected line shows it from the start of the wait, as the pushes during the wait do.
      if (state.pendingSelection !== null) { state.selection = state.pendingSelection; renderSelection(); }
      sees = document.createElement('div');
      sees.className = 'pv-sees';
      sees.textContent = yourTurnSeesText(state.selection);
      (card.querySelector('.pv-body') || card).appendChild(sees);
    }
    appendToChat(card);
    let timer = null;
    const decide = holdCard(id, { card, yourTurn: text, sees }, signal, (decision) => {
      clearTimeout(timer);
      card.remove();
      resolve(decision);
    });
    if (timeoutMs > 0) timer = setTimeout(() => decide('timeout'), timeoutMs);
  });
}

// The Your-turn card's selection line (plain text; set as textContent): "The panel sees: «brown fox» (9 characters)".
const YOUR_TURN_SEES_CHARS = 80;
function yourTurnSeesText(selection) {
  const s = String(selection || '');
  if (!s) return 'The panel sees nothing selected yet';
  const one = s.replace(/\s+/g, ' ');
  const shown = one.length > YOUR_TURN_SEES_CHARS ? one.slice(0, YOUR_TURN_SEES_CHARS) + '…' : one;
  return `The panel sees: «${shown}» (${fmtNum(s.length)} character${s.length === 1 ? '' : 's'})`;
}

// A selection pushed by the document while the panel is busy: the waiting Your-turn cards that show the
// selection get it. Returns whether a Your-turn card waits (onRuntimeMessage then updates the Selected line too).
function showYourTurnSelection(text) {
  let waiting = false;
  for (const p of pendingPreviews.values()) {
    if (!p.yourTurn) continue;
    waiting = true;
    if (p.sees) p.sees.textContent = yourTurnSeesText(text);
  }
  return waiting;
}

// Button handler: resolves a pending permission card. Returns false when it is no longer pending.
function decidePreview(id, decision) {
  const p = pendingPreviews.get(id);
  if (!p) return false;
  p.decide(decision);
  return true;
}

// ---------------------------------------------------------------------------
// Destructive-edit gate (Auto mode)
// ---------------------------------------------------------------------------
// A planned write waits for Allow / Deny when it is large (GATE_DELETE_LINES, GATE_REPLACE_CHARS,
// GATE_REPLACE_ALL_COUNT, GATE_FORMAT_LINES for a list write; insert_after_line and format_text never by size) or when the turn is tainted
// (snap.tainted: earlier in this turn the model read an opened document or got web search results, whose
// text could carry instructions). Ordinary small edits of an untainted turn pass without a card. The plan
// is computed before the gate (it gives the real line range and the removed text) and committed by the
// caller after Allow, with the usual revision check (the document may change while the card waits).
// "Allow all in this turn" (snap.editAll) lets the remaining gated edits of the turn through, except those that
// always ask (replace_section, an edit that removes a tracked citation).

// First and last lines of a text for the card (plain text; escaped when rendered).
const EXCERPT_LINE_CHARS = 120;
function gateExcerpt(text) {
  const cut = (l) => (l.length > EXCERPT_LINE_CHARS ? l.slice(0, EXCERPT_LINE_CHARS) + '…' : l);
  const lines = String(text || '').split('\u000b').join('\n').split('\n').filter((l) => l.trim());
  if (lines.length <= 2) return lines.map(cut).join('\n');
  const more = lines.length - 2;
  return `${cut(lines[0])}\n… (${fmtNum(more)} more line${more === 1 ? '' : 's'}) …\n${cut(lines[lines.length - 1])}`;
}

// What a planned write does, for the gate: { large, what, range, excerptLabel, excerpt, why? (the card's
// sentence instead of the size one), always? (asks even after "Allow all in this turn") }, or null for tools that are never gated (undo_last_edit). remember passes
// { action, text }. plan: the write plan (docs-write.js), or for a replace_selection that is pasted (no API plan)
// { journal: { restore: <the selection> } }. A plan that removes tracked citations (plan.citations, set by
// runWriteTool from references.js) always asks, whatever its size.
function editGateInfo(name, plan) {
  const extra = extraTool(name); // registerTools: its own gate rule (none: asks only in a tainted turn)
  if (extra) return extra.gate ? extra.gate(name, plan) : { large: false, what: `runs ${name}`, range: '', excerptLabel: '', excerpt: '' };
  const info = toolGateInfo(name, plan);
  const cites = (plan && plan.citations) || [];
  if (!info || !cites.length) return info;
  const removes = `removes citation${cites.length === 1 ? '' : 's'} ${cites.join(', ')}`;
  return { ...info, large: true, always: true, why: info.why ? `${info.why} It ${removes}.` : `This edit ${removes}.` };
}
function toolGateInfo(name, plan) {
  const j = (plan && plan.journal) || {};
  const [from, to] = (plan && plan.region) || [];
  const range = from ? (from === to ? `Line ${from}` : `Lines ${from}–${to}`) : '';
  const count = (n, w) => `${fmtNum(n)} ${w}${n === 1 ? '' : 's'}`;
  if (name === 'delete_lines') {
    const n = to - from + 1;
    return { large: n >= GATE_DELETE_LINES, what: `deletes ${count(n, 'line')}`, range, excerptLabel: 'Removed text', excerpt: gateExcerpt(j.restore) };
  }
  if (name === 'replace_text' || name === 'replace_selection') {
    const n = String(j.restore || '').length;
    return { large: n >= GATE_REPLACE_CHARS, what: `replaces ${count(n, 'character')}`, range, excerptLabel: 'Removed text', excerpt: gateExcerpt(j.restore) };
  }
  if (name === 'replace_section') { // a whole section is a large edit by nature: always asks
    const s = plan.section;
    const lines = s.from === s.to ? `line ${s.from}` : `lines ${s.from}–${s.to}`;
    return { large: true, always: true, what: `replaces the section «${s.name}»`, why: `Replaces the section «${s.name}» (${lines}).`, range,
      excerptLabel: s.removed.trim() ? 'Removed text' : '', excerpt: gateExcerpt(s.removed) };
  }
  if (name === 'replace_all') {
    const n = Number(j.count) || 0;
    return { large: n >= GATE_REPLACE_ALL_COUNT, what: `replaces ${count(n, 'occurrence')}`, range,
      excerptLabel: 'Change', excerpt: `"${oneLine(j.restore || '', 100)}" → "${oneLine(j.find || '', 100)}"` };
  }
  if (name === 'insert_after_line') {
    return { large: false, what: 'inserts text', range, excerptLabel: 'Inserted text', excerpt: gateExcerpt(String(j.text || '').replace(/^\n/, '')) };
  }
  if (name === 'format_text') return { large: false, what: 'changes formatting', range, excerptLabel: 'Formatted text', excerpt: gateExcerpt(j.text) };
  if (name === 'format_lines') { // only a list write is large: its undo re-creates the lists approximately
    const n = to - from + 1;
    return { large: !!plan.listSet && n >= GATE_FORMAT_LINES, what: `changes paragraph formatting of ${count(n, 'line')}`, range, excerptLabel: 'Formatted lines', excerpt: gateExcerpt(plan.cardText) };
  }
  if (name === 'remember') { // never large: asks only in a tainted turn
    return { large: false, what: plan.action === 'add' ? 'adds a line to the document instructions' : 'removes a line from the document instructions',
      range: '', excerptLabel: 'Rule', excerpt: oneLine(plan.text, 300) };
  }
  return null;
}

// The gate before a planned write (Auto mode only: the callers run after canEdit; remember, which is no
// document edit, also in Manual). Returns null when the
// write may go ahead, otherwise the tool message fields of the refusal. Sets ui.decision when the gate
// applied ('accepted' | 'accepted-all' | 'rejected' | 'stopped'); executeTool stores it as _decision.
// First the registered beforeWrite checks (registry.js; ui.args: the call's arguments, set by runToolCall): a
// refuse ends the call here, before any card; their notes go on ui.notes for executeTool.
async function gateEdit(name, plan, snap, ui = {}) {
  const check = await beforeWriteChecks(name, plan, ui.args || {}, snap);
  if (check.notes.length) ui.notes = (ui.notes || []).concat(check.notes);
  if (check.refuse) return { content: `Refused by a check: ${check.refuse}`, _ok: false, _message: 'Refused by a check' };
  const info = editGateInfo(name, plan);
  if (!info || (!info.large && !snap.tainted)) return null;
  // Allow all covers the size and taint gates; a section replacement and a removed citation ask every time.
  if (snap.editAll && !info.always) { ui.decision = 'accepted-all'; return null; }
  const why = (info.why || (info.large ? `Large edit: it ${info.what}.` : `This edit ${info.what}.`)) +
    (snap.tainted ? ' Earlier in this answer the assistant read text that may carry instructions that did not come from you: an opened document, web search results or hidden text in this document.' : '');
  const preview = { tool: name, kind: 'edit', title: 'Allow this edit?', why, range: info.range, excerptLabel: info.excerptLabel, excerpt: info.excerpt };
  const d = await confirmOpen(preview, snap.signal, ui);
  if (d === 'accept' || d === 'accept-all') {
    if (d === 'accept-all') snap.editAll = true;
    ui.decision = 'accepted';
    setStatus('Editing the document…');
    return null;
  }
  ui.decision = d === 'stop' ? 'stopped' : 'rejected';
  return d === 'stop'
    ? { content: EDIT_STOPPED_TEXT, _ok: false, _message: 'Edit not applied: stopped' }
    : { content: EDIT_DENIED_TEXT, _ok: false, _message: 'Edit not allowed' };
}

// ---------------------------------------------------------------------------
// Read first: a rewrite of lines the model has not read in this message
// ---------------------------------------------------------------------------
// The document reaches the model only as the outline of the turn context (tools turns never carry its text), so a
// replace_section or delete_lines may remove lines the model never saw. executeTool records the line numbers each
// successful result on the main document showed (noteSeenLines: read_lines, read_formatting, find_in_document, the
// lines of get_selection, the edit reports); the beforeWrite check refuses such a write once, with the current text
// of the unread lines, so a re-read is often unnecessary. The identical call again passes (the model's decision).
// Empty lines and the heading of replace_section (it is in the outline) need no reading. Only in the model's calls of
// a visible main-chat turn (toolLoop sets snap.readFirst; not the self-test, not the panel's own calls); writes run
// only in Auto; insert_after_line and the formatting tools are not checked.
const READ_FIRST_TOOLS = ['replace_section', 'delete_lines'];
const SEEN_LINE_RE = /^(\d+)(?: \[[^\]\n]*\])*: /;

function noteSeenLines(name, args, r, snap) {
  if (!snap || !r || !r._ok || typeof r.content !== 'string' || name === 'open_document') return;
  if (args && !isMainDocRef(args.doc)) return; // an opened document's line numbers are not the main document's
  const seen = snap.seenLines || (snap.seenLines = new Set());
  if (name === 'get_selection') {
    const m = /^Selection \(lines (\d+)-(\d+)/.exec(r.content);
    if (m) for (let i = Number(m[1]); i <= Number(m[2]); i++) seen.add(i);
    return;
  }
  for (const line of r.content.split('\n')) {
    const m = SEEN_LINE_RE.exec(line);
    if (m) seen.add(Number(m[1]));
  }
}

// The current text of lines from..to, numbered: all of them, or the first and last READ_FIRST_EDGE_LINES.
function readFirstExcerpt(lines, from, to) {
  const row = (n) => `${n}: ${oneLine(showText(lines[n - 1] || ''), READ_FIRST_LINE_CHARS)}`;
  const nums = [];
  for (let n = from; n <= to; n++) nums.push(n);
  if (nums.length <= 2 * READ_FIRST_EDGE_LINES) return nums.map(row).join('\n');
  const head = nums.slice(0, READ_FIRST_EDGE_LINES);
  const tail = nums.slice(-READ_FIRST_EDGE_LINES);
  return [...head.map(row), `[lines ${head[head.length - 1] + 1}–${tail[0] - 1} not shown]`, ...tail.map(row)].join('\n');
}

// beforeWrite(name, plan, args, snap) -> null | { refuse }.
function readFirstCheck(name, plan, args, snap) {
  if (!READ_FIRST_TOOLS.includes(name) || !snap || !snap.readFirst || !plan || !Array.isArray(plan.region) || snap.docText == null) return null;
  const lines = docLines(snap);
  const from = Math.max(1, name === 'replace_section' ? plan.region[0] + 1 : plan.region[0]);
  const to = Math.min(plan.region[1], lines.length);
  const seen = snap.seenLines || new Set();
  const unread = [];
  for (let n = from; n <= to; n++) if (String(lines[n - 1]).trim() && !seen.has(n)) unread.push(n);
  if (!unread.length) return null;
  const key = name + '\u0000' + JSON.stringify(args || {});
  if (!snap.readFirstRefused) snap.readFirstRefused = new Set();
  if (snap.readFirstRefused.has(key)) return null;
  snap.readFirstRefused.add(key);
  const a = unread[0];
  const b = unread[unread.length - 1];
  const span = a === b ? `line ${a}` : `lines ${a}–${b}`;
  return { refuse: `you have not read ${span} in this message. ${a === b ? 'It currently says' : 'They currently say'}:\n${readFirstExcerpt(lines, a, b)}\n` +
    'Read them with read_lines if you need more, then call the tool again.' };
}

registerTurnHook('beforeWrite', readFirstCheck);
