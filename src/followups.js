'use strict';
// Module followups.js: after a /research answer with the provider's web search (OpenAI, Anthropic): the check of the
// report skeleton (a notice when key findings carry no source link) and the "Ask about" chips for the sources the answer
// did not use. Both run on the finish hook, without a model call; the chips are never stored and go with the next turn.
/* global addNotice, appendToChat, el, registerTurnHook, renderQueue, sendMessage, state, webSearchTurn */
/* exported turnResearch, keyFindings, unlinkedFindings, unusedSources, shortSourceTitle, followupText, renderFollowups,
   clearFollowups, FOLLOWUPS_MAX */

const FOLLOWUPS_MAX = 3;
const FOLLOWUP_TITLE_MAX = 60;
const FOLLOWUP_QUESTION_MAX = 160;

// The answer of a /research turn: { question, text, sources } (sources of every round, de-duplicated by URL), or null for
// another turn, a provider without web search or an empty answer.
function turnResearch(userMsg, snap, chatCtx) {
  if (!userMsg || userMsg._persona !== 'research' || !snap || !webSearchTurn('research', snap) || !chatCtx) return null;
  const at = chatCtx.messages.indexOf(userMsg);
  if (at < 0) return null;
  const answers = chatCtx.messages.slice(at + 1).filter((m) => m.role === 'assistant');
  const text = answers.map((m) => m.content || '').filter((t) => t.trim()).join('\n\n');
  if (!text.trim()) return null;
  const sources = [];
  for (const m of answers) for (const s of m._sources || []) if (s && s.url && !sources.some((x) => x.url === s.url)) sources.push(s);
  return { question: String(userMsg.content || '').trim(), text, sources };
}

// ---- The key findings check -------------------------------------------------------------------------------------
// The bullets of the answer's "Key findings" section (English or Russian heading, as a Markdown heading, a bold line or
// a plain "Key findings:" line), each with its continuation lines; [] when there is no such section.
const plainLine = (l) => l.replace(/^\s*#{1,6}\s*/, '').replace(/[*_]/g, '').trim();
const KEY_FINDINGS_RE = /^(?:key findings|main findings|ключевые (?:выводы|результаты|находки)|основные (?:выводы|результаты|находки))\s*:?$/i;
const SKELETON_RE = /^(?:tl;?dr|details|sources|references|caveats|limitations|подробности|детали|источники|литература|оговорки|ограничения)\s*:?$/i;
const BULLET_RE = /^(\s*)(?:[-*•+]|\d+[.)])\s+/;
const isHeadingLine = (l) => /^\s*#{1,6}\s/.test(l) || /^\s*(\*\*|__)[^*_]+(\*\*|__)\s*:?\s*$/.test(l) || SKELETON_RE.test(plainLine(l)) || KEY_FINDINGS_RE.test(plainLine(l));
function keyFindings(text) {
  const lines = String(text || '').split('\n');
  const start = lines.findIndex((l) => KEY_FINDINGS_RE.test(plainLine(l)));
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (isHeadingLine(l) && !BULLET_RE.test(l)) break;
    const m = BULLET_RE.exec(l);
    if (m && (!out.length || m[1].length < 2)) out.push(l.trim());
    else if (out.length && l.trim()) out[out.length - 1] += ' ' + l.trim(); // a continuation or a sub-bullet
  }
  return out;
}
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; } };
// A bullet carries a source link: a URL or a Markdown link, or the title or host of one of the turn's sources (the
// provider's citations).
function hasSourceLink(bullet, sources) {
  if (/https?:\/\//i.test(bullet) || /\]\([^)\s]+\)/.test(bullet)) return true;
  const b = bullet.toLowerCase();
  return sources.some((s) => {
    const title = String(s.title || '').trim().toLowerCase();
    const host = hostOf(s.url);
    return (title.length >= 8 && b.includes(title)) || (host && b.includes(host));
  });
}
const unlinkedFindings = (text, sources = []) => keyFindings(text).filter((b) => !hasSourceLink(b, sources)).length;

// ---- Chips for the sources the answer did not use -----------------------------------------------------------------
const normUrl = (u) => String(u || '').toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[/#]+$/, '');
// A source's title without a trailing site name (" | Nature", " - Wikipedia") when enough is left, clipped at a word.
function shortSourceTitle(s) {
  let t = String((s && s.title) || '').replace(/\s+/g, ' ').trim();
  if (!t) return hostOf(s && s.url) || String((s && s.url) || '');
  const m = /^(.{12,}?)\s+[|·–—-]\s+[^|·–—-]{2,40}$/.exec(t);
  if (m) t = m[1].trim();
  if (t.length > FOLLOWUP_TITLE_MAX) t = t.slice(0, FOLLOWUP_TITLE_MAX).replace(/\s+\S*$/, '') + '…';
  return t;
}
// The sources the answer text does not mention by URL or by title, at most FOLLOWUPS_MAX, in their order.
function unusedSources(text, sources) {
  const t = String(text || '').toLowerCase();
  const tUrls = t.replace(/https?:\/\/(www\.)?/g, '');
  return (sources || []).filter((s) => {
    const u = normUrl(s.url);
    if (u && tUrls.includes(u)) return false;
    const title = String(s.title || '').trim().toLowerCase();
    const short = title ? shortSourceTitle(s).replace(/…$/, '').toLowerCase() : ''; // not the host of an untitled source
    return !((title.length >= 8 && t.includes(title)) || (short.length >= 8 && t.includes(short)));
  }).slice(0, FOLLOWUPS_MAX);
}
const cyrillicShare = (s) => {
  const letters = String(s || '').match(/\p{L}/gu) || [];
  return letters.length ? letters.filter((c) => /\p{Script=Cyrillic}/u.test(c)).length / letters.length : 0;
};
// The message a chip sends: a /research follow-up in the language of the user's question.
function followupText(title, question) {
  let q = String(question || '').replace(/\s+/g, ' ').trim().replace(/[?.!…:;,\s]+$/, '');
  if (q.length > FOLLOWUP_QUESTION_MAX) q = q.slice(0, FOLLOWUP_QUESTION_MAX).replace(/\s+\S*$/, '') + '…';
  if (cyrillicShare(question) >= 0.3) return `/research Что добавляет «${title}» к вопросу: ${q}?`;
  return `/research What does «${title}» add to the question: ${q}?`;
}

// The chips under the last answer of the chat (or at the end of the chat): one button per unused source.
function renderFollowups(chips) {
  clearFollowups();
  if (!chips.length || !el.chat) return null;
  const box = document.createElement('div');
  box.className = 'followups';
  for (const c of chips) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn small followup-chip';
    b.textContent = `Ask about: ${c.title}`;
    b.title = c.text;
    b.addEventListener('click', () => { sendFollowup(c.text, b); });
    box.appendChild(b);
  }
  const answers = el.chat.querySelectorAll('.msg.assistant');
  const last = answers.length ? answers[answers.length - 1] : null;
  if (last && last.parentNode === el.chat && typeof last.after === 'function') last.after(box);
  else appendToChat(box);
  return box;
}
function clearFollowups() {
  if (!el.chat) return;
  for (const n of [...el.chat.querySelectorAll('.followups')]) n.remove();
}
// A chip's message through the Send path, once (the chips go); while an answer runs it is queued like a typed message.
function sendFollowup(text, btn) {
  if (btn && btn.disabled) return Promise.resolve(false);
  if (btn) btn.disabled = true;
  clearFollowups();
  const q = { text, docId: state.docId, chatId: state.chatId };
  if (state.busy) {
    const cur = state.queued;
    state.queued = cur ? { ...cur, text: cur.text + '\n\n' + q.text } : q;
    renderQueue();
    return Promise.resolve(true);
  }
  return sendMessage(q).then(() => true);
}

// Runs fn once the panel is no longer busy with a turn (the turn's final re-render drops anything added before).
function followupsWhenIdle(fn, tries = 1200) {
  if (!state.busy) { fn(); return; }
  if (tries > 0) setTimeout(() => followupsWhenIdle(fn, tries - 1), 50);
}

registerTurnHook('finish', (userMsg, snap, chatCtx) => {
  const r = turnResearch(userMsg, snap, chatCtx);
  if (!r) return;
  const missing = unlinkedFindings(r.text, r.sources);
  const stopped = !!(snap.signal && snap.signal.aborted);
  const chips = !stopped && r.sources.length
    ? unusedSources(r.text, r.sources).map((s) => { const title = shortSourceTitle(s); return { title, text: followupText(title, r.question) }; })
    : [];
  if (!missing && !chips.length) return;
  const { docId, chatId } = chatCtx;
  followupsWhenIdle(() => {
    if (state.docId !== docId || state.chatId !== chatId) return;
    if (missing) addNotice(`${missing} key finding${missing === 1 ? ' has' : 's have'} no source link.`, { sticky: true });
    if (chips.length) renderFollowups(chips);
  });
});
// The next message removes the chips (they belong to the answer just given).
registerTurnHook('beforeTurn', () => { clearFollowups(); return ''; });
