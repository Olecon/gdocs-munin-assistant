'use strict';
// Module gate.js: the permission gates: Allow / Deny cards (confirmOpen) and their button handler
// (decidePreview) for open_document, for the edits that ask (gateEdit: every write in Manual, in Auto only what the
// panel cannot undo) and for Undo all (kind 'undo-all'), the ask_user
// questionnaire card (askUser, kind 'ask'), the access card (kind 'access', references.js), and the attention dot on the
// collapsed panel's round button while a card waits (notifyAttention), and the read-first beforeWrite check
// (readFirstCheck, noteSeenLines).
/* global appendToChat, ASK_AGAIN_TEXT, cardPreview, docLines, isMainDocRef, READ_FIRST_EDGE_LINES, READ_FIRST_LINE_CHARS, registerTurnHook, showText, beforeWriteChecks, ASK_MAX_OPTIONS, ASK_MAX_QUESTIONS, askQuestionsOf, ASK_STOPPED_TEXT, EDIT_DENIED_TEXT, EDIT_STOPPED_TEXT, escapeHtml, extraTool, fmtNum,
   HOST_TAB_ID, oneLine, orbCreate, orbSetState, renderSelection, scrollToBottom,
   setStatus, state, wordDiff, wordDiffHtml, capFirst, plural, rangeLabel */
/* exported pendingPreviews, watchCards, askUser, answeredCard, confirmOpen, confirmYourTurn, decidePreview, editPreview, gateEdit, noteDenied, showYourTurnSelection, noteSeenLines, remapSeenLines */

// ---------------------------------------------------------------------------
// Permission gates: Allow / Deny cards
// ---------------------------------------------------------------------------
// Opening a document the user did not name, and an edit that asks (gateEdit), waits for permission: the tool
// call pauses, an Allow / Deny card is shown, and the tool result goes back to the model only after the
// decision. Card data (plain text only; escaped when rendered):
//   { tool: 'open_document', title, kind: 'open', url, authuser?, mainAuthuser? }
//   { tool: <write tool>, title, kind: 'edit', why, range?, blocks: [{ head } | { label, text, diff? }] } (editPreview:
//     the whole change, never cut)
//   { tool: 'Undo all', title, kind: 'undo-all', why, items: [{ title, mark: { st, label }, note }], confirm } (docs-undo.js
//     undoAllCard; buttons: confirm, which resolves 'accept' (none when confirm is null), and Cancel: 'reject')
//   { tool: 'ask_user', title, kind: 'ask', questions: [{ question, options: [string], multiple }] } (askUser; the
//     questionnaire, one question at a time: resolves 'answered' with preview.answers set)
//   { tool, title, kind: 'access', text, onAllow } (requestReferencesAccess, references.js; Allow calls onAllow()
//     inside the click, since chrome.permissions.request needs the user gesture, and resolves 'accept' when its promise
//     gives true, 'refused' otherwise; Not now: 'reject')
function previewBodyHtml(pv) {
  if (pv.kind === 'access') return `<div class="pv-note">${escapeHtml(pv.text)}</div>`;
  if (pv.kind === 'undo-all') {
    return `<div class="pv-note">${escapeHtml(pv.why)}</div>` + pv.items.map((it) => `<div class="pv-line"><span class="mk ${escapeHtml(it.mark.st)}" role="img" aria-label="${escapeHtml(it.mark.label)}" data-tip="${escapeHtml(it.mark.label)}"></span> ${escapeHtml(it.title)}</div>` +
      (it.note ? `<div class="pv-note">${escapeHtml(it.note)}</div>` : '')).join('');
  }
  if (pv.kind === 'edit') {
    return `<div class="pv-note">${escapeHtml(pv.why)}</div>` +
      (pv.range ? `<div class="pv-anchor">${escapeHtml(pv.range)}</div>` : '') + (pv.blocks || []).map(changeBlockHtml).join('');
  }
  return '<div class="pv-anchor">The assistant wants to read this document and send its text to the AI provider:</div>' +
    `<div class="pv-line">${escapeHtml(pv.url)}</div>` +
    (pv.authuser !== undefined ? `<div class="pv-anchor">Google account index ${escapeHtml(pv.authuser == null ? 'default' : pv.authuser)} ` +
      `(the main document uses ${escapeHtml(pv.mainAuthuser == null ? 'the default' : pv.mainAuthuser)})</div>` : '');
}

// One part of an edit card's change: an operation's heading (edit_document), or a text in the look of an answer's edit
// block (a label bar, the text in the body font, wrapped, never cut; sidepanel.css .pv-edit) with, for a replacement,
// the word diff of the write row folded under it (uncut too).
function changeBlockHtml(b) {
  if (b.head != null) return `<div class="pv-op">${escapeHtml(b.head)}</div>`;
  return `<div class="code-wrap edit-block pv-text"><div class="code-bar"><span class="code-lang">${escapeHtml(b.label)}</span></div>` +
    `<pre>${escapeHtml(b.text)}</pre></div>` +
    (b.diff ? `<details class="pv-diff"><summary>What changed</summary><div class="word-diff">${wordDiffHtml(wordDiff(b.diff.oldText, b.diff.newText), Infinity)}</div></details>` : '');
}

// No icon: the tool's name and the question say what the card is about. The head is in the row typography (CSS), so
// the card's switch to its answered row does not jump.
const previewHead = (pv) => `<div class="pv-head"><span class="pv-tool">${escapeHtml(pv.tool)}</span> · ${escapeHtml(pv.title)}</div>`;

// ---- Waiting for the decision -----------------------------------------------------------------------
// Pending permission cards (card id -> { card, decide }). The buttons resolve them through the chat's
// click handler (decidePreview); the turn's abort signal (Stop) resolves them with 'stop'. Chats cannot
// be switched while a turn runs, and collapsing the panel only hides it, so a pending card always ends
// with a click or with Stop.
const pendingPreviews = new Map();
let previewSeq = 0;
// Button tooltips per card kind: Allow, Deny, Allow all in this turn.
const BUTTON_TIPS = {
  open: ['Open this document', 'Do not open it', 'Allow every document this turn'],
  edit: ['Apply this edit', 'Do not apply it', 'Allow every edit this turn'],
  'undo-all': ['Undo these edits', 'Undo nothing'],
  access: ['Chrome asks once', 'No lookups now'],
};

// watchCards(fn): fn(number of pending cards) after every change; returns the function that stops it. An agent's
// clock (agents.js) pauses while a card waits for the user.
const cardWatchers = new Set();
function watchCards(fn) { cardWatchers.add(fn); return () => cardWatchers.delete(fn); }

// Tells the Docs tab whether a card is waiting (content.js puts a dot on the collapsed panel's round
// button while one is). The tab: the turn's pinned document tab, else the host tab. Best effort.
function notifyAttention() {
  for (const fn of cardWatchers) { try { fn(pendingPreviews.size); } catch (e) { /* a watcher's error stays its own */ } }
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

// ---- The answered state -------------------------------------------------------------------------------
// A decided card becomes one row in place, in the style of a write's row (the owner's choice: the record of a decision
// reads like the other rows, no box): "<tool> \u00b7 <answer> \u00b7 <preview of what it asked>", which opens on a click to the
// card's title and the whole of what it asked (the question, the reason for an edit card, the link, the access
// request). The stored chat draws the same row (renderHistory: the tool message's _answered, which executeTool stores
// from ui.answered). a: { kind ('ask' | 'edit' | 'open' | 'access'), tool, title, text, decision ('accept' | 'accept-all'
// | 'reject' | 'stop' | 'refused' | 'option'), choice (the answer of a one-question ask card), questions (a card of
// several questions: [{ question, answer }], no answer when it ended by Stop) }. A chat stored with the removed
// "I'll answer in chat" button has decision 'chat': drawn by the ask fallback below.
const ANSWER_LABELS = {
  ask: { stop: 'Stopped' },
  access: { accept: 'Allowed', reject: 'Not now', refused: 'Not granted by Chrome', stop: 'Stopped' },
  other: { accept: 'Allowed', 'accept-all': 'Allowed all in this turn', reject: 'Denied', stop: 'Stopped' },
};
// An empty choice or a dash is never shown as a choice: the row then reads "Answered in the chat".
const blankChoice = (c) => !String(c == null ? '' : c).replace(/[\s\-\u2010-\u2015\u2212]/g, '');
// The questions of a stored several-question ask entry (a one-question entry has none: text and choice say it all).
const answeredQuestions = (a) => (a.kind === 'ask' && Array.isArray(a.questions) ? a.questions.filter((q) => q && typeof q === 'object') : []);
function answeredText(a) {
  const qs = answeredQuestions(a);
  if (a.kind === 'ask' && a.decision === 'option' && qs.length > 1) return `Answered ${qs.length} questions`;
  if (a.kind === 'ask' && a.decision === 'option' && !blankChoice(a.choice)) return `Chosen: ${a.choice}`;
  const labels = ANSWER_LABELS[a.kind] || ANSWER_LABELS.other;
  return labels[a.decision] || (a.kind === 'ask' ? 'Answered in the chat' : 'Decided');
}
function answeredCardHtml(a) {
  const answer = answeredText(a);
  const preview = cardPreview(a.text);
  const qs = answeredQuestions(a);
  // A questionnaire's fold: each question with its answer, numbered as on the card.
  const asked = qs.length > 1 ? qs.map((q, i) => `<div class="log-asked">${i + 1}. ${escapeHtml(String(q.question || ''))}` +
    `${q.answer ? ` \u2014 ${escapeHtml(String(q.answer))}` : ''}</div>`).join('') : a.text ? `<div class="log-asked">${escapeHtml(a.text)}</div>` : '';
  return `<details class="log-fold"><summary data-tip="${escapeHtml(`${a.tool} \u00b7 ${answer}`)}"><span class="activity-name">${escapeHtml(a.tool)}</span>` +
    ` \u00b7 <span class="log-status">${escapeHtml(answer)}</span>${preview ? `<span class="log-preview"> \u00b7 ${escapeHtml(preview)}</span>` : ''}</summary>` +
    `<div class="log-body"><div class="log-what">${escapeHtml(a.title)}</div>${asked}</div></details>`;
}
const answeredClass = (a) => `answered-row ${a.kind || 'open'}`;
// The row of a stored decision (renderHistory), not appended to the chat.
function answeredCard(a) {
  const d = document.createElement('div');
  d.className = answeredClass(a);
  d.innerHTML = answeredCardHtml(a);
  return d;
}
// What a card asked, kept in its answered row's fold.
const askedText = (pv) => (pv.kind === 'ask' ? pv.questions[0].question : pv.kind === 'access' ? pv.text : pv.kind === 'edit' ? pv.why : pv.url || '');
// Turns a decided card into its answered row and records the decision on ui.answered (one entry per card of the
// call: an access card and an edit card may both ask in one call). The Undo all card is removed by its caller.
function answerCard(card, preview, decision, ui) {
  card.classList.add('decided'); // hides the buttons
  if (preview.kind === 'undo-all') return;
  const a = { kind: preview.kind || 'open', tool: preview.tool, title: preview.title, text: String(askedText(preview) || ''), decision };
  if (preview.kind === 'ask') askAnsweredEntry(a, preview);
  card.className = answeredClass(a); // the same element: its place in the stage and the callers' references hold
  card.innerHTML = answeredCardHtml(a);
  (ui.answered || (ui.answered = [])).push(a);
}

// Shows the permission card (in place of ui.card, the pending card of the tool call, when there is one)
// and resolves with 'accept' | 'accept-all' | 'reject' | 'stop' (an access card also 'refused': Chrome did not grant). ui.card is set to the permission card,
// which stays in the chat in its answered state once decided (answerCard); an answered card of the same call is not
// replaced. ui.cards: every card the call showed (a quiet tool loop removes them). ui.place(card): puts the card into
// the turn's bubble (render.js placeRoundCard: its cards slot) or an agent's block (placeAgentCard), true when it did;
// else the card goes at the end of the chat. ui.settle(card): called once the card is answered (render.js
// settleRoundCard moves the answered row after its call's row).
// ui.waitedMs: how long the call's cards waited for the user (the turn's "Worked for" leaves it out).
function confirmOpen(preview, signal, ui = {}) {
  if (signal && signal.aborted) return Promise.resolve('stop');
  return new Promise((resolve) => {
    const id = 'pv' + (++previewSeq);
    const card = document.createElement('div');
    card.className = 'tool-card preview' + (preview.kind === 'ask' ? ' ask' : preview.kind === 'access' ? ' access' : '');
    const [allowTip, denyTip, allTip] = BUTTON_TIPS[preview.kind] || BUTTON_TIPS.open;
    // An edit card's body grows with its text (no inner scrollbar: the chat scrolls); the other kinds keep their box.
    const body = preview.kind === 'edit' ? 'pv-edit' : 'pv-body';
    card.innerHTML = previewHead(preview) + (preview.kind === 'ask' ? askCardHtml(preview, id) : `<div class="${body}">${previewBodyHtml(preview)}</div>` +
      '<div class="tool-actions pv-actions">' + (preview.kind === 'access' ? accessButtons(id) : preview.kind === 'undo-all' ? undoAllButtons(preview, id) :
      `<button class="btn small primary" type="button" data-act="preview-accept" data-preview="${id}" data-tip="${allowTip}">Allow</button>` +
      `<button class="btn small" type="button" data-act="preview-reject" data-preview="${id}" data-tip="${denyTip}">Deny</button>` +
      `<button class="btn small ghost" type="button" data-act="preview-accept-all" data-preview="${id}" data-tip="${allTip}">Allow all in this turn</button>`) +
      '</div>');
    const placed = typeof ui.place === 'function' && !!ui.place(card);
    if (!placed) appendToChat(card, false);
    if (ui.card && ui.card !== card && ui.card.isConnected && ui.card.classList.contains('pending')) {
      if (placed) ui.card.remove(); else ui.card.replaceWith(card);
    }
    ui.card = card;
    (ui.cards || (ui.cards = [])).push(card);
    // A card in a bubble or an agent's block may be above the end of the chat: brought into view, no further.
    if (placed && typeof card.scrollIntoView === 'function') card.scrollIntoView({ block: 'nearest' }); else scrollToBottom(true);
    const shown = waitNow();
    const decide = holdCard(id, { card }, signal, (decision) => {
      ui.waitedMs = (ui.waitedMs || 0) + Math.max(0, waitNow() - shown);
      if (preview.kind === 'ask') decision = askOutcome(preview, decision);
      answerCard(card, preview, decision, ui);
      if (typeof ui.settle === 'function') ui.settle(card);
      resolve(decision);
    });
    // The controls of an ask card are handled here (the chat's click handler knows only the data-act ones).
    if (preview.kind === 'ask') wireAskCard(card, preview, id, decide);
    if (preview.kind === 'access') card.addEventListener('click', (ev) => accessClick(ev, card, preview, decide));
    setStatus(preview.kind === 'ask' ? 'Waiting for your answer…' : 'Waiting for your decision…');
  });
}

// The clock of the waits on the user (a function, so tests can replace it).
function waitNow() { return Date.now(); }

// The buttons of an access card (data-access, handled by the card itself: Allow must call chrome.permissions.request
// in the click).
function accessButtons(id) {
  const [allowTip, laterTip] = BUTTON_TIPS.access;
  return `<button class="btn small primary" type="button" data-access="allow" data-preview="${id}" data-tip="${allowTip}">Allow</button>` +
    `<button class="btn small" type="button" data-access="later" data-preview="${id}" data-tip="${laterTip}">Not now</button>`;
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
// ask_user: a questionnaire that blocks the model
// ---------------------------------------------------------------------------
// askUser({questions: [{question, options}]}, snap, ui) returns the tool message fields (a call stored before the
// questionnaire, {question, options}, is read as one question). Not a document edit and not a gate: no journal, no
// Allow / Deny; the card (kind 'ask') waits for "Send" (or a click on an answer of a one-question card, or Apply) or
// Stop: a user who would rather answer in the chat presses Stop or types in Other. One card per message
// (snap.askedUser): a second call is refused, so a small model cannot loop on questions. A quiet tool loop (the
// self-test) has nobody to answer: refused. ui.decision ('answered' | 'stopped') becomes _decision.
const ASK_TEXT_CHARS = 300;
const ASK_OPTION_CHARS = 80;
const ASK_ANSWER_CHARS = 500; // an Other answer (the input's maxlength)
async function askUser(args, snap, ui = {}) {
  const fail = (content, message) => ({ content, _ok: false, _message: message, _cardText: '' });
  if (snap.quiet) return fail('Error: ask_user is not available here; decide yourself and say what you assumed.', 'Not available here');
  if (snap.askedUser) return fail(ASK_AGAIN_TEXT, 'Only one question per answer');
  const { questions, error } = askQuestions(args);
  if (error) return fail(error, 'Invalid question');
  snap.askedUser = true;
  const preview = { tool: 'ask_user', title: questions.length > 1 ? 'Questions' : 'Question', kind: 'ask', questions };
  const d = await confirmOpen(preview, snap.signal, ui);
  const base = { _cardText: '', _detail: questions.map((q) => q.question).join('\n') };
  if (d === 'answered' && preview.answers) {
    ui.decision = 'answered';
    const lines = questions.map((q, i) => `${i + 1}. ${q.question} — ${preview.answers[i] || '(no answer)'}`);
    return { ...base, content: `The user answered:\n${lines.join('\n')}`, _ok: true,
      _message: questions.length > 1 ? `Answered ${questions.length} questions` : `Chosen: ${preview.answers[0]}` };
  }
  ui.decision = 'stopped';
  return { ...base, content: ASK_STOPPED_TEXT, _ok: false, _message: 'Question not answered: stopped' };
}

// The questions of a call, trimmed and clipped: { questions } or { error } (the refusal's text). Only no question, more
// than ASK_MAX_QUESTIONS or an empty question refuse; the suggested answers are made usable instead (a weak model
// sends five, or one twice): blank and non-string ones dropped, duplicates dropped, the first ASK_MAX_OPTIONS kept
// (none is fine, the Other field takes the answer).
function askQuestions(args) {
  const list = askQuestionsOf(args || {});
  if (!list.length || list.length > ASK_MAX_QUESTIONS) {
    return { error: `Error: ask_user takes 1 to ${ASK_MAX_QUESTIONS} questions; this call has ${list.length}.` };
  }
  const out = [];
  for (const [i, q] of list.entries()) {
    const question = q && typeof q === 'object' && typeof q.question === 'string' ? oneLine(q.question.trim(), ASK_TEXT_CHARS) : '';
    if (!question) return { error: `Error: question ${i + 1} of ask_user has no text; give every question its text.` };
    const given = Array.isArray(q.options) ? q.options.filter((o) => typeof o === 'string' && o.trim()).map((o) => oneLine(o.trim(), ASK_OPTION_CHARS)) : [];
    const options = [...new Set(given)].slice(0, ASK_MAX_OPTIONS);
    out.push({ question, options, multiple: q.multiple === true });
  }
  return { questions: out };
}

// ---- The questionnaire card ------------------------------------------------------------------------
// One question at a time (preview.ask.cur): the numbers of the questions (several only; the current one marked, the
// answered ones done, a click goes back), the question, its suggested answers as a numbered list and an Other field
// (Enter confirms). An answer is recorded and the next unanswered question opens; nothing reaches the model before Send,
// which shows on the last question and on any question once all are answered. One question keeps the old card's
// feel: a click on an answer sends at once, unless something is typed in Other (then Send). A multiple question
// (multiple: true) toggles its answers and has Apply instead: it takes the picked answers and the Other text, joined
// with "; ", and moves on like a click (on the last question it sends the card). State per question: picks[i] (an
// option index, 'other' or null; single questions), sel[i] (the picked option indexes; multiple questions) and
// other[i] (the Other text, kept when an option is picked).
function askState(preview) {
  if (!preview.ask) {
    const n = preview.questions.length;
    preview.ask = { cur: 0, picks: Array(n).fill(null), sel: preview.questions.map(() => []), other: Array(n).fill('') };
  }
  return preview.ask;
}
// The answer of question i, '' while it has none.
function askAnswerOf(preview, i) {
  const st = askState(preview);
  const q = preview.questions[i];
  if (q.multiple) {
    return [...q.options.filter((o, k) => st.sel[i].includes(k)), st.other[i].trim()].filter(Boolean).join('; ');
  }
  const pick = st.picks[i];
  if (pick === 'other') return st.other[i].trim();
  return pick == null ? '' : q.options[pick] || '';
}
const askAllAnswered = (preview) => preview.questions.every((q, i) => !!askAnswerOf(preview, i));
// A number can be clicked when its question is answered or is the first one without an answer.
const askReachable = (preview, i) => preview.questions.slice(0, i).every((q, j) => !!askAnswerOf(preview, j));
// Send is for single questions; a multiple question has Apply in its place.
function askShowsSend(preview) {
  const st = askState(preview);
  const n = preview.questions.length;
  if (preview.questions[st.cur].multiple) return false;
  if (n === 1) return !!st.other[0].trim();
  return st.cur === n - 1 || askAllAnswered(preview);
}

// What the drawn card depends on, besides the Other text the user is typing.
const askShownKey = (preview) => {
  const st = askState(preview);
  return [st.cur, st.picks[st.cur], st.sel[st.cur].join('.'), ...preview.questions.map((q, i) => !!askAnswerOf(preview, i)), askShowsSend(preview)].join();
};

function askCardHtml(preview, id) {
  const st = askState(preview);
  const n = preview.questions.length;
  const q = preview.questions[st.cur];
  const steps = n < 2 ? '' : '<div class="ask-steps" role="group" aria-label="Questions">' + preview.questions.map((x, i) => {
    const done = !!askAnswerOf(preview, i);
    return `<button type="button" class="ask-step${i === st.cur ? ' current' : ''}${done ? ' done' : ''}" data-ask-step="${i}" data-preview="${id}"` +
      `${i === st.cur ? ' aria-current="step"' : ''}${askReachable(preview, i) ? '' : ' disabled'} aria-label="Question ${i + 1}${done ? ', answered' : ''}">${i + 1}</button>`;
  }).join('') + '</div>';
  const pick = st.picks[st.cur];
  // Only a picked answer is the primary button (nothing before a pick: the owner does not want the first one to look
  // answered); a multiple question: every picked answer is, in the same style.
  const options = q.options.map((o, i) => {
    const on = q.multiple ? st.sel[st.cur].includes(i) : pick === i;
    return `<button class="btn small ask-option${on ? ' primary selected' : ''}" type="button" data-ask="${i}" data-preview="${id}"` +
      ` aria-pressed="${on}">${i + 1}. ${escapeHtml(o)}</button>`;
  }).join('');
  const otherChosen = q.multiple ? !!st.other[st.cur].trim() : pick === 'other';
  const end = q.multiple
    ? `<button class="btn small primary" type="button" data-ask="apply" data-preview="${id}"${askAnswerOf(preview, st.cur) ? '' : ' disabled'}>Apply</button>`
    : askShowsSend(preview)
      ? `<button class="btn small primary" type="button" data-ask="send" data-preview="${id}"${askAllAnswered(preview) ? '' : ' disabled'}>Send</button>` : '';
  return `${steps}<div class="pv-body"><div class="pv-note">${escapeHtml(q.question)}</div></div>` +
    (options ? `<div class="tool-actions pv-actions ask-options">${options}</div>` : '') +
    `<div class="ask-other-row"><input class="ask-other${otherChosen ? ' chosen' : ''}" type="text" placeholder="Other" aria-label="Other answer"` +
    ` maxlength="${ASK_ANSWER_CHARS}" data-ask-other data-preview="${id}" value="${escapeHtml(st.other[st.cur])}"></div>` +
    (end ? `<div class="tool-actions pv-actions ask-end">${end}</div>` : '');
}

// Draws the current question again; focus: 'answer' (the picked or first answer, else the Other field), 'other' (the
// Other field, caret at the end), an option index (a toggled answer keeps the focus) or none (the first drawing must
// not take the focus from the chat input).
function renderAskCard(card, preview, id, focus) {
  card.innerHTML = previewHead(preview) + askCardHtml(preview, id);
  if (focus == null || typeof card.querySelector !== 'function') return;
  const input = card.querySelector('input[data-ask-other]');
  const target = focus === 'other' ? input
    : typeof focus === 'number' ? card.querySelector(`button[data-ask="${focus}"]`)
      : card.querySelector('button.selected[data-ask]') || card.querySelector('.ask-options button[data-ask]') || input;
  if (!target || typeof target.focus !== 'function') return;
  target.focus();
  if (target === input && typeof input.setSelectionRange === 'function') input.setSelectionRange(input.value.length, input.value.length);
}

// After an answer: the next question without one (after the current, then from the start), else the last question,
// where Send is.
function askAdvance(preview) {
  const st = askState(preview);
  const n = preview.questions.length;
  for (let k = 1; k <= n; k++) {
    const i = (st.cur + k) % n;
    if (!askAnswerOf(preview, i)) { st.cur = i; return; }
  }
  st.cur = n - 1;
}

function wireAskCard(card, preview, id, decide) {
  const st = askState(preview);
  const n = preview.questions.length;
  const multiple = () => !!preview.questions[st.cur].multiple;
  let shown = askShownKey(preview); // what the card shows now (confirmOpen drew it)
  const draw = (focus) => { renderAskCard(card, preview, id, focus); shown = askShownKey(preview); };
  // A one-question card sends with its answer, unless the user typed in Other (then Send decides).
  const answered = (typedOther) => {
    if (n === 1 && (typedOther || !st.other[0].trim())) { decide('send'); return; }
    askAdvance(preview);
    draw('answer');
  };
  // Apply of a multiple question: the last question (or the only one) sends the card once every question has an
  // answer; otherwise the next question opens.
  const apply = () => {
    if (!askAnswerOf(preview, st.cur)) return;
    if (st.cur === n - 1 && askAllAnswered(preview)) { decide('send'); return; }
    askAdvance(preview);
    draw('answer');
  };
  card.addEventListener('click', (ev) => {
    const t = ev.target && ev.target.closest ? ev.target : null;
    const step = t && t.closest('button[data-ask-step]');
    if (step && !step.disabled) { st.cur = Number(step.dataset.askStep); draw('answer'); return; }
    const b = t && t.closest('button[data-ask]');
    if (!b || b.disabled) return;
    if (b.dataset.ask === 'send') { if (askAllAnswered(preview)) decide('send'); return; }
    if (b.dataset.ask === 'apply') { apply(); return; }
    const k = Number(b.dataset.ask);
    if (multiple()) {
      const sel = st.sel[st.cur];
      st.sel[st.cur] = sel.includes(k) ? sel.filter((x) => x !== k) : [...sel, k];
      draw(k);
      return;
    }
    st.picks[st.cur] = k;
    answered(false);
  });
  // Typed Other text is the answer of the current question (a click on an option switches back; clearing the field
  // leaves the question without an answer); of a multiple question, one more answer after the picked ones. The card is
  // drawn again only when that changes what it shows (the pick, the done mark, Send, Apply), so typing keeps its focus
  // and caret; never during an IME composition (the redraw would break it): compositionend draws it.
  const typed = (input, composing) => {
    st.other[st.cur] = String(input.value || '');
    if (!multiple()) {
      if (st.other[st.cur].trim()) st.picks[st.cur] = 'other';
      else if (st.picks[st.cur] === 'other') st.picks[st.cur] = null;
    }
    if (!composing && askShownKey(preview) !== shown) draw('other');
  };
  const isOther = (t) => !!(t && t.matches && t.matches('input[data-ask-other]'));
  card.addEventListener('input', (ev) => { if (isOther(ev.target)) typed(ev.target, !!ev.isComposing); });
  card.addEventListener('compositionend', (ev) => { if (isOther(ev.target)) typed(ev.target, false); });
  card.addEventListener('keydown', (ev) => {
    const t = ev.target;
    if (!t || !t.matches) return;
    if (ev.key === 'Enter' && t.matches('input[data-ask-other]')) {
      ev.preventDefault();
      if (ev.isComposing) return;
      st.other[st.cur] = String(t.value || '');
      if (multiple()) { apply(); return; }
      if (!st.other[st.cur].trim()) return;
      st.picks[st.cur] = 'other';
      answered(true);
      return;
    }
    // The arrows move between the question numbers.
    if ((ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') && t.matches('button[data-ask-step]')) {
      const steps = [...card.querySelectorAll('button[data-ask-step]:not([disabled])')];
      const next = steps[steps.indexOf(t) + (ev.key === 'ArrowLeft' ? -1 : 1)];
      if (next) { ev.preventDefault(); next.focus(); }
    }
  });
}

// The answers of a decided ask card: 'send' takes the card's state; 'option:<i>' (each question without an answer
// gets its own option i, the last one when it has fewer) and 'answers:<JSON list>' answer it programmatically (tests,
// the tool evaluation). Returns 'answered' (preview.answers set) or 'stop'.
function askOutcome(preview, decision) {
  const st = askState(preview);
  const m = /^option:(\d+)$/.exec(decision);
  if (m) {
    preview.questions.forEach((q, i) => {
      if (askAnswerOf(preview, i) || !q.options.length) return;
      const k = Math.min(Number(m[1]), q.options.length - 1);
      if (q.multiple) st.sel[i] = [k]; else st.picks[i] = k;
    });
    decision = 'send';
  }
  if (typeof decision === 'string' && decision.startsWith('answers:')) {
    let list = [];
    try { list = JSON.parse(decision.slice('answers:'.length)); } catch (e) { list = []; }
    preview.answers = preview.questions.map((q, i) => (Array.isArray(list) && typeof list[i] === 'string' ? list[i].trim() : ''));
    return 'answered';
  }
  if (decision === 'send') {
    preview.answers = preview.questions.map((q, i) => askAnswerOf(preview, i));
    return 'answered';
  }
  return 'stop';
}

// The answered entry of an ask card (answerCard): a one-question card keeps the shape stored before the
// questionnaire (text: the question, choice: the answer), so old and new chats draw the same row; several questions
// add questions: [{ question, answer }] (no answer after Stop).
function askAnsweredEntry(a, preview) {
  const answers = a.decision === 'answered' ? preview.answers : null;
  if (answers) a.decision = 'option';
  if (preview.questions.length === 1) {
    if (answers) a.choice = String(answers[0] || '');
    return;
  }
  a.questions = preview.questions.map((q, i) => (answers ? { question: q.question, answer: String(answers[i] || '') } : { question: q.question }));
}

// The two buttons of an Undo all card (no "all in this turn": it is not part of a turn); without preview.confirm
// (nothing would be undone) only Close.
function undoAllButtons(preview, id) {
  const [okTip, cancelTip] = BUTTON_TIPS['undo-all'];
  return (preview.confirm ? `<button class="btn small primary" type="button" data-act="preview-accept" data-preview="${id}" data-tip="${okTip}">${escapeHtml(preview.confirm)}</button>` : '') +
    `<button class="btn small" type="button" data-act="preview-reject" data-preview="${id}" data-tip="${cancelTip}">${preview.confirm ? 'Cancel' : 'Close'}</button>`;
}

// The self-test's "Your turn" card: an instruction for the user (plain text) with Skip, built like a permission
// card and decided through the same map and button handler (decidePreview; data-act "preview-skip"). There is no
// Continue: the self-test watches the document itself (opts.until, a promise that resolves with a truthy value once
// it sees the change). Resolves with 'done' (until) | 'skip' | 'stop' (the signal: Stop) | 'timeout' (after
// opts.timeoutMs, when set). The card is removed once decided; the attention dot shows while it waits.
// opts.showSelection: the card also shows what the panel sees selected (yourTurnSeesText), kept up to date by the
// document's SELECTION_UPDATE (onRuntimeMessage → showYourTurnSelection) and the self-test's own selection reads;
// for the steps that ask the user to select text.
function confirmYourTurn(text, signal, { timeoutMs = 0, showSelection = false, until = null } = {}) {
  if (signal && signal.aborted) return Promise.resolve('stop');
  return new Promise((resolve) => {
    const id = 'pv' + (++previewSeq);
    const card = document.createElement('div');
    card.className = 'tool-card preview your-turn';
    card.innerHTML = '<div class="pv-head"><span class="pv-tool">Your turn</span> · self-test</div>' +
      `<div class="pv-body"><div class="pv-note">${escapeHtml(text)}</div></div>` +
      '<div class="tool-actions pv-actions">' +
      `<button class="btn small" type="button" data-act="preview-skip" data-preview="${id}" data-tip="Skip this step">Skip</button>` +
      '</div>';
    // A listening orb of its own (orb.js): the self-test's loop has no bubble to carry one.
    const head = card.querySelector('.pv-head');
    if (head) { const orb = orbCreate(); head.insertBefore(orb, head.firstChild); orbSetState(orb, 'wave'); }
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
    if (until) until.then((seen) => { if (seen) decide('done'); }, () => {});
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
// The edit gate
// ---------------------------------------------------------------------------
// The rule (the owner's): in Auto, what the panel's Undo can take back does not ask; in Manual (snap.askEdits: the
// message was sent with the mode button on Manual) every write that comes here asks. So a write waits for Allow / Deny
// (gateAsks) in Manual; in Auto only when the panel cannot undo it (its gate info says undoable: false: deleting comments,
// accepting or rejecting suggested changes) and either the tool asks for it (asks) or the turn is tainted (snap.tainted:
// earlier in this turn the model read an opened document, web search results or hidden text, which could carry
// instructions). remember (memory) asks in a tainted turn in both modes: an injected line would reach every later chat.
// The plan is computed before the gate (it gives the lines and the old and new text) and committed by the caller after
// Allow, with the usual revision check (the document may change while the card waits). "Allow all in this turn"
// (snap.editAll) lets the turn's remaining writes through, except those that always ask (always: replace_section, an edit
// that removes a tracked citation, deleting comments the user did not ask to delete).
function gateAsks(info, snap) {
  if (info.memory) return !!snap.tainted;
  if (snap.askEdits) return true;
  return info.undoable === false && (!!info.asks || !!snap.tainted);
}

// What a planned write does, for the gate: { what (the card's sentence, without its period), blocks (the change, whole:
// [{ head } | { label, text, diff? }]), range? (a line under the sentence: registered tools), why? (the sentence instead
// of what), always?, asks?, undoable?, memory? (gateAsks) }, or null for tools that never ask (undo_last_edit). A
// registered tool's gate gives one text as excerptLabel and excerpt; remember passes { scope, action, text, old? }.
// plan: the write plan (docs-write.js), or for a replace_selection that is pasted (no API plan) { journal: { restore:
// <the selection> }, cardOld: <the selection>, cardNew: <the new text> }. A plan that removes tracked citations
// (plan.citations: runWriteTool and replaceSelectionCall, from references.js) always asks in Manual and says so.
function editGateInfo(name, plan) {
  const extra = extraTool(name); // registerTools: its own gate info (none: a document edit that shows what it runs)
  if (extra) {
    const g = extra.gate ? extra.gate(name, plan) : { what: `runs ${name}` };
    return g && { ...g, blocks: g.blocks || (g.excerpt ? [{ label: g.excerptLabel || 'Text', text: String(g.excerpt) }] : []) };
  }
  const info = name === 'remember' ? rememberGateInfo(plan) : name === 'edit_document' ? editDocumentView(plan) : changeView(name, plan);
  const cites = (plan && plan.citations) || [];
  if (!info || !cites.length) return info;
  return { ...info, always: true, why: `${capFirst(info.what)}. It removes citation${cites.length === 1 ? '' : 's'} ${cites.join(', ')}.` };
}

// The change of one write of the line tools (a single tool's plan, or one operation of edit_document with its tool's
// name): { what, blocks, always? }, or null for a tool that never asks. Plan fields: region ([from, to], the lines
// before the edit), cardOld / cardNew (a replacement: the changed paragraphs whole, before and after; docs-write.js
// replacePlan), cardText / cardLabel (the text the write puts in, removes or formats), place (an insertion's), how (a
// formatting write's values in words), section (replace_section), journal (replace_all: restore, replaces, find, count).
function changeView(name, plan) {
  const p = plan || {};
  const j = p.journal || {};
  const [from, to] = p.region || [];
  const place = from ? rangeLabel(from, to) : '';
  const shown = (t) => showText(String(t == null ? '' : t));
  if (name === 'replace_text' || name === 'replace_selection') {
    const where = place || 'the selection';
    const oldText = shown(typeof p.cardOld === 'string' ? p.cardOld : j.restore);
    const newText = shown(typeof p.cardNew === 'string' ? p.cardNew : p.cardText);
    const blocks = newText.trim()
      ? [{ label: `${capFirst(where)} after the edit`, text: newText, ...(oldText.trim() && oldText !== newText ? { diff: { oldText, newText } } : {}) }]
      : [{ label: `Removed: ${where}`, text: oldText }];
    return { what: `replaces ${where}`, blocks };
  }
  if (name === 'replace_section') { // a whole section: always asks in Manual, also after "Allow all in this turn"
    const s = p.section;
    const oldText = shown(s.removed);
    const newText = shown(p.cardText);
    const blocks = newText.trim()
      ? [{ label: `The section «${s.name}» after the edit`, text: newText, ...(oldText.trim() ? { diff: { oldText, newText } } : {}) }]
      : [{ label: `Removed: the text of «${s.name}»`, text: oldText }];
    return { what: `replaces the section «${s.name}» (${rangeLabel(s.from, s.to)})`, blocks, always: true };
  }
  if (name === 'delete_lines') return { what: `deletes ${place}`, blocks: [{ label: `Removed: ${place}`, text: shown(p.cardText != null ? p.cardText : j.restore) }] };
  if (name === 'insert_after_line') {
    const at = p.place || (place ? `after line ${from}` : '');
    return { what: `inserts text ${at}`, blocks: [{ label: `Inserted ${at}`, text: shown(typeof p.insertedText === 'string' ? p.insertedText : p.cardText) }] };
  }
  if (name === 'replace_all') {
    const n = Number(j.count) || 0;
    const olds = [...new Set(Array.isArray(j.replaces) ? j.replaces : [j.restore])].map(shown);
    const newText = shown(j.find);
    return { what: `${newText ? 'replaces' : 'removes'} ${plural(n, 'occurrence')}${place ? ` on ${place}` : ''}`,
      blocks: [{ label: `Replaced (${plural(n, 'occurrence')})`, text: olds.join('\n') }, ...(newText ? [{ label: 'With', text: newText }] : [])] };
  }
  if (name === 'format_text' || name === 'format_lines') {
    const n = Number(p.count) || 0; // format_text all: true
    const where = n > 1 ? `${plural(n, 'occurrence')} on ${place}` : place;
    const what = p.cardWhat || (p.how ? `formats ${where}: ${p.how}` : `changes ${where}: ${p.done || 'formatting'}`);
    return { what, blocks: p.cardText ? [{ label: p.cardLabel || 'Formatted text', text: shown(p.cardText) }] : [] };
  }
  return null;
}

// edit_document (plan.ops: its parts in document order, docs-write.js planEditDocument): its operations in the call's
// order, each under its number (as the results name them) and shown as its own tool's write; a format_text with all:
// true is one operation of several parts.
const OP_TOOLS = { replace: 'replace_text', insert: 'insert_after_line', delete: 'delete_lines', format_text: 'format_text', format_lines: 'format_lines', number_headings: 'format_lines' };
function editDocumentView(plan) {
  const byOp = new Map();
  for (const p of plan.ops || []) byOp.set(p.k, [...(byOp.get(p.k) || []), p]);
  const ks = [...byOp.keys()].sort((a, b) => a - b);
  const blocks = [];
  for (const k of ks) {
    const group = byOp.get(k);
    const p = group.length > 1 ? { ...group[0], count: group.length, region: [Math.min(...group.map((x) => x.region[0])), Math.max(...group.map((x) => x.region[1]))] } : group[0];
    const v = changeView(OP_TOOLS[p.op], p);
    if (v) blocks.push({ head: `${k + 1}. ${capFirst(v.what)}.` }, ...v.blocks);
  }
  const [from, to] = plan.region || [];
  return { what: `makes ${plural(ks.length, 'edit')}${from ? ` on ${rangeLabel(from, to)}` : ''}`, blocks };
}

// remember (doc-instructions.js): asks in a tainted turn only, in both modes.
function rememberGateInfo(plan) {
  const where = plan.scope === 'main' ? 'MAIN.md' : 'DOC.md';
  const text = String(plan.text || '');
  const what = plan.action === 'replace' ? `changes a line of ${where}` : plan.action === 'add' ? `adds a line to ${where}` : `removes a line from ${where}`;
  const diff = plan.action === 'replace' && plan.old ? { diff: { oldText: String(plan.old), newText: text } } : {};
  return { memory: true, what, blocks: [{ label: 'Rule', text, ...diff }] };
}

// The card of a planned write (gateEdit; personGate in docs-write.js passes its own sentence as why): the sentence,
// then the change in full. In a tainted turn the reason is appended; a write that mentions people says they may be
// notified (personGate then asks no second time).
const TAINT_TEXT = ' Earlier in this answer the assistant read text that may carry instructions that did not come from you: an opened document, web search results or hidden text in this document.';
function editPreview(name, plan, snap, { info = editGateInfo(name, plan), why = '' } = {}) {
  const people = (plan && plan.people) || [];
  const mention = people.length && !why
    ? ` It mentions ${people.slice(0, 5).join(', ')}${people.length > 5 ? ', …' : ''}; Google Docs may notify ${people.length === 1 ? 'this person' : 'these people'}.` : '';
  const sentence = why || info.why || `${capFirst(info.what)}.`;
  return { tool: name, kind: 'edit', title: 'Allow this edit?', why: sentence + mention + (snap && snap.tainted ? TAINT_TEXT : ''), range: info.range || '', blocks: info.blocks || [] };
}

// The gate before a planned write (every writing path: the Docs API tools, the paste, the registered writing tools,
// remember). Returns null when the write may go ahead, otherwise the tool message fields of the refusal. Sets
// ui.decision when a card or Allow all decided ('accepted' | 'accepted-all' | 'rejected' | 'stopped'); executeTool
// stores it as _decision. First the registered beforeWrite checks (registry.js; ui.args: the call's arguments, set by
// runToolCall): a refuse ends the call here, before any card; their notes go on ui.notes for executeTool. Several
// writes of one round ask one card at a time, in call order: the round runs its calls one after another.
async function gateEdit(name, plan, snap, ui = {}) {
  // A call the user denied in this turn, sent again unchanged: no second card; an "Error:" so the repeat guard counts it.
  if (snap.deniedCalls && snap.deniedCalls.has(deniedKey(name, ui))) {
    return { content: `Error: ${EDIT_DENIED_TEXT}`, _ok: false, _message: 'Edit not allowed' };
  }
  const check = await beforeWriteChecks(name, plan, ui.args || {}, snap);
  if (check.notes.length) ui.notes = (ui.notes || []).concat(check.notes);
  if (check.refuse) return { content: `Refused by a check:${check.refusals.length > 1 ? '\n' : ' '}${check.refuse}`, _ok: false, _message: 'Refused by a check', _detail: check.refuse };
  const info = editGateInfo(name, plan);
  if (!info || !gateAsks(info, snap)) return null;
  if (snap.editAll && !info.always) { ui.decision = 'accepted-all'; return null; }
  const d = await confirmOpen(editPreview(name, plan, snap, { info }), snap.signal, ui);
  if (d === 'accept' || d === 'accept-all') {
    if (d === 'accept-all') snap.editAll = true; // the card reads "Allowed all in this turn" (ui.answered)
    ui.decision = 'accepted';
    setStatus('Editing the document…');
    return null;
  }
  ui.decision = d === 'stop' ? 'stopped' : 'rejected';
  if (d !== 'stop') noteDenied(name, snap, ui);
  return d === 'stop'
    ? { content: EDIT_STOPPED_TEXT, _ok: false, _message: 'Edit not applied: stopped' }
    : { content: EDIT_DENIED_TEXT, _ok: false, _message: 'Edit not allowed' };
}
// The calls the user denied in this turn (snap.deniedCalls: name and arguments; the snapshot is new every turn).
const deniedKey = (name, ui) => name + '\u0000' + JSON.stringify((ui && ui.args) || {});
function noteDenied(name, snap, ui) {
  if (!snap) return;
  (snap.deniedCalls || (snap.deniedCalls = new Set())).add(deniedKey(name, ui));
}

// ---------------------------------------------------------------------------
// Read first: a rewrite of lines the model has not read in this message
// ---------------------------------------------------------------------------
// The document reaches the model only as the outline of the turn context (tools turns never carry its text), so a
// replace_section or delete_lines may remove lines the model never saw. executeTool records the line numbers each
// successful result on the main document showed (noteSeenLines: read_document, find_in_document, the
// lines of get_selection, the edit reports); the beforeWrite check refuses such a write once, with the current text
// of the unread lines, so a re-read is often unnecessary. The identical call again passes (the model's decision).
// Empty lines and the heading of replace_section (it is in the outline) need no reading. Only in the model's calls of
// a visible main-chat turn (toolLoop sets snap.readFirst; not the self-test, not the panel's own calls); writes run
// only in an editing turn; insert_after_line and the formatting tools are not checked (edit_document: its delete
// operations).
const READ_FIRST_TOOLS = ['replace_section', 'delete_lines', 'edit_document'];
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

// A write replaces the turn's document (setSnapModel) and shifts its line numbers: the seen set follows it. Lines before
// the changed stretch keep their numbers, lines after it move by the line delta; a seen line inside it keeps being seen
// only where its text occurs once in the old and once in the new stretch (edit_document may change two distant places).
// The rest is dropped: the edit report names the new lines (noteSeenLines runs after this).
function remapSeenLines(snap, oldText) {
  if (!snap || !snap.seenLines || !snap.seenLines.size || oldText == null || snap.docText == null || snap.docText === oldText) return;
  const oldLines = String(oldText).split('\n');
  const newLines = docLines(snap);
  const n = Math.min(oldLines.length, newLines.length);
  let p = 0;
  while (p < n && oldLines[p] === newLines[p]) p++;
  let t = 0;
  while (t < n - p && oldLines[oldLines.length - 1 - t] === newLines[newLines.length - 1 - t]) t++;
  const b = oldLines.length - t; // the changed old lines are p+1..b, the new ones p+1..bNew
  const bNew = newLines.length - t;
  const delta = bNew - b;
  const counts = (list, from, to) => {
    const m = new Map();
    for (let i = from; i < to; i++) m.set(list[i], (m.get(list[i]) || 0) + 1);
    return m;
  };
  let oldMid = null; let newAt = null;
  const seen = new Set();
  for (const ln of snap.seenLines) {
    if (ln <= p) seen.add(ln);
    else if (ln > b) seen.add(ln + delta);
    else {
      if (!oldMid) {
        oldMid = counts(oldLines, p, b);
        newAt = new Map();
        const newMid = counts(newLines, p, bNew);
        for (let i = p; i < bNew; i++) if (newMid.get(newLines[i]) === 1) newAt.set(newLines[i], i + 1);
      }
      const text = oldLines[ln - 1];
      if (oldMid.get(text) === 1 && newAt.has(text)) seen.add(newAt.get(text));
    }
  }
  snap.seenLines = seen;
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
  // edit_document: the lines of its delete operations.
  const regions = name === 'edit_document' ? (plan.ops || []).filter((p) => p.op === 'delete').map((p) => p.region)
    : [[name === 'replace_section' ? plan.region[0] + 1 : plan.region[0], plan.region[1]]];
  const seen = snap.seenLines || new Set();
  const unread = [];
  for (const [a, b] of regions) {
    for (let n = Math.max(1, a); n <= Math.min(b, lines.length); n++) if (String(lines[n - 1]).trim() && !seen.has(n)) unread.push(n);
  }
  if (!unread.length) return null;
  const key = name + '\u0000' + JSON.stringify(args || {});
  if (!snap.readFirstRefused) snap.readFirstRefused = new Set();
  if (snap.readFirstRefused.has(key)) return null;
  snap.readFirstRefused.add(key);
  const a = unread[0];
  const b = unread[unread.length - 1];
  const span = a === b ? `line ${a}` : `lines ${a}–${b}`;
  return { refuse: `you have not read ${span} in this message. ${a === b ? 'It currently says' : 'They currently say'}:\n${readFirstExcerpt(lines, a, b)}\n` +
    'Read them with read_document if you need more, then call the tool again.' };
}

registerTurnHook('beforeWrite', readFirstCheck);
