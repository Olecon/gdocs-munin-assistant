'use strict';
// Module review.js: /review, the independent reviewer. The command is a PERSONAS entry (constants.js) and a document
// pass (request.js: one request without the chat history: the review head, the whole numbered document or its
// outline plus the reading tools, the rubric REVIEW_RUBRIC of prompts.js; Munin in raw mode). Here: the finish hook
// that turns the answer into anchored findings (findings.js: parsed, verified against the turn's document, sorted;
// the stored answer becomes their Markdown and the findings go on the message as _review), the card that replaces
// the answer's text wherever the chat shows it (decorateReviews, on every change of the chat), and Fix flagged
// (fixFlagged: one normal user message through the Send path).
/* global addError, el, FINDINGS_PARSE_ERROR, findingGroup, findingsCard, findingsMarkdown, findingsWhenIdle, flaggedFindings,
   parseFindings, registerTurnHook, renderQueue, sendMessage, sortFindings, state, verifyFindings, isAutoMode */
/* exported REVIEW_CRITERIA, reviewResult, fixFlaggedText, fixFlaggedState, fixFlagged, decorateReviews, reviewCard */

// The rubric's criteria (REVIEW_RUBRIC) as the card names them.
const REVIEW_CRITERIA = {
  claims: 'Claims vs evidence', methods: 'Methods', numbers: 'Numbers', structure: 'Structure', terms: 'Terminology',
  hedging: 'Hedging', refs: 'Figures and tables', abstract: 'Abstract vs body', support: 'Abstract and conclusions vs results',
};
const REVIEW_TITLE = 'Review';

// The findings of a review answer against the document the turn started with: { ok, criteria, findings } (sorted,
// verified), or parseFindings' failure. A criterion with findings that are not supported claims and no verdict of
// its own counts as FAIL.
function reviewResult(raw, snap) {
  const parsed = parseFindings(raw);
  if (!parsed.ok) return parsed;
  const view = { ...(snap || {}), ...((snap && snap.promptView) || {}) };
  const findings = sortFindings(verifyFindings(parsed.findings, view.docText));
  const criteria = { ...parsed.criteria };
  for (const f of findings) {
    if (f.criterion && !criteria[f.criterion] && ['critical', 'major', 'minor'].includes(findingGroup(f))) criteria[f.criterion] = 'FAIL';
  }
  return { ok: true, criteria, findings };
}

// The end of a /review turn (also after Stop or an error): the newest answer of the turn becomes the findings'
// Markdown (what later turns and a re-render show; the card covers it, decorateReviews) with the findings on
// _review; an answer that does not parse stays as it came, with an error under it.
registerTurnHook('finish', (userMsg, snap, chatCtx) => {
  if (!userMsg || userMsg._persona !== 'review' || !chatCtx) return;
  const msgs = chatCtx.messages;
  const at = msgs.indexOf(userMsg);
  const replies = msgs.slice(at + 1).filter((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim());
  const reply = replies[replies.length - 1];
  if (!reply || reply._review) return;
  const res = bestReview(replies, snap);
  if (!res.ok) {
    if (!(snap && snap.signal && snap.signal.aborted)) findingsWhenIdle(() => addError(`${FINDINGS_PARSE_ERROR} Its text is shown as it came; run /review again.`));
    return;
  }
  // The answer of a review cut by the length limit comes in two parts (the automatic continuation): the findings
  // go on the last one, and the raw parts before it are emptied (an answer without text is neither shown nor sent).
  for (const m of replies) if (m !== reply && !m.tool_calls) m.content = '';
  reply._review = { criteria: res.criteria, findings: res.findings };
  reply.content = findingsMarkdown(res, { title: REVIEW_TITLE, labels: REVIEW_CRITERIA });
});
// The reading of a turn's answers with the most findings: the last answer, all of them joined (a continuation that
// carried on the JSON after a length cut), or the first (a continuation that started over in prose).
function bestReview(replies, snap) {
  const texts = [replies[replies.length - 1].content];
  if (replies.length > 1) texts.push(replies.map((m) => m.content).join(''), replies[0].content);
  let best = null;
  for (const t of texts) {
    const r = reviewResult(t, snap);
    if (r.ok && (!best || r.findings.length > best.findings.length)) best = r;
  }
  return best || { ok: false };
}

// ---- The card ---------------------------------------------------------------------------------------------------
// Fix flagged works only where the edit can be verified: Auto with the document read through the Docs API.
function fixFlaggedState() {
  if (!isAutoMode()) return { ok: false, reason: 'Fix flagged edits the document: switch to Edit automatically first.' };
  if (!state.googleConnected || state.docFormat !== 'docs-api') return { ok: false, reason: 'Fix flagged needs the Google Docs API: sign in with Google in Settings.' };
  return { ok: true, reason: '' };
}
// The message Fix flagged sends: the flagged findings, numbered, each with its line and quote.
function fixFlaggedText(list) {
  const items = list.map((f, i) => {
    const what = [f.detail, f.action ? `Fix: ${f.action}` : ''].filter(Boolean).join(' ');
    return `${i + 1}. Line ${f.line}, «${f.quote}»${what ? `: ${what}` : ''}`;
  });
  return `Fix the flagged findings:\n${items.join('\n')}\nChange only those places, one edit per finding; keep every number and citation.`;
}
// Sends the Fix flagged message through the Send path (the chat lock, the gates and the writing checks apply); while
// an answer runs it is queued like a message typed then. hint: the card's line that says why the button is off.
function fixFlagged(review, btn, hint) {
  const s = fixFlaggedState();
  if (hint) { hint.textContent = s.reason; hint.classList.toggle('hidden', s.ok); }
  if (!s.ok || (btn && btn.disabled)) return Promise.resolve(false);
  const list = flaggedFindings(review.findings || []);
  if (!list.length) return Promise.resolve(false);
  if (btn) { btn.disabled = true; btn.textContent = 'Sent'; }
  const q = { text: fixFlaggedText(list), docId: state.docId, chatId: state.chatId };
  if (state.busy) {
    const cur = state.queued;
    state.queued = cur ? { ...cur, text: cur.text + '\n\n' + q.text } : q;
    renderQueue();
    return Promise.resolve(true);
  }
  return sendMessage(q).then(() => true);
}
// The card of a stored review (m._review), with Fix flagged when there is something to fix.
function reviewCard(review) {
  const actions = [];
  const flagged = flaggedFindings(review.findings || []);
  if (flagged.length) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn small primary review-fix';
    btn.textContent = `Fix flagged (${flagged.length})`;
    btn.title = 'Ask for one edit per flagged finding, at its line';
    const hint = document.createElement('span');
    hint.className = 'st-hint review-fix-hint';
    const s = fixFlaggedState();
    if (!s.ok) { btn.classList.add('off'); hint.textContent = s.reason; } else hint.classList.add('hidden');
    btn.addEventListener('click', () => { fixFlagged(review, btn, hint); });
    actions.push(btn, hint);
  }
  return findingsCard(review, { title: REVIEW_TITLE, labels: REVIEW_CRITERIA, actions });
}
// Puts the card into every shown answer that is a stored review (its text is the review's Markdown) and hides that
// text and the answer's Apply / Copy (the card has its own Copy, of the same Markdown). Runs on every change of the
// chat, so the card comes back after each re-render, a chat switch and a reload.
function decorateReviews() {
  if (!el.chat || !state.messages.some((m) => m._review)) return;
  const reviews = state.messages.filter((m) => m.role === 'assistant' && m._review);
  for (const b of el.chat.querySelectorAll('.msg.assistant')) {
    if (b._reviewCard || typeof b._text !== 'string' || !b._parts) continue;
    const m = reviews.find((r) => r.content === b._text);
    if (!m) continue;
    const card = reviewCard(m._review);
    b._reviewCard = card;
    b._parts.md.classList.add('hidden');
    b._parts.actions.classList.add('hidden');
    b.insertBefore(card, b._parts.place);
  }
}
if (typeof MutationObserver === 'function' && el.chat) new MutationObserver(decorateReviews).observe(el.chat, { childList: true });
