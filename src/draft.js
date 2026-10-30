'use strict';
// Module draft.js: draft mode for long texts, all through the registry: the draft tool (plan / done / end), its
// prompt line, a beforeTurn line while a plan exists, a finish notice when the last section is written, and the
// plan checklist card in the chat. The plan belongs to one chat: muninDraft:<docId>:<chatId> in
// chrome.storage.local, { sections: [{ heading, intent, done }], readers: [{ reader, question, section }], updatedAt }.
// A section counts as written when draft(done) marked it or when the document has its heading (normalized) with at
// least DRAFT_BODY_WORDS words below it before the next heading (draftStatus): the checklist follows the document,
// not only the tool. A reader question is open while the section it names is not written.
/* global addNotice, apiEditing, appendToChat, countWords, el, escapeHtml, registerTools, registerTurnHook, state, storageSet */
/* exported DRAFT_PREFIX, DRAFT_MAX_SECTIONS, DRAFT_DEF, draftKey, readDraft, draftLine, draftTool, draftStatus, draftHeadingKey,
   openReaderQuestions, refreshDraftCard, endDraftFromCard */

const DRAFT_PREFIX = 'muninDraft:';
const DRAFT_MAX_SECTIONS = 30;
const DRAFT_MAX_QUESTIONS = 8; // 3–4 readers with one or two questions each
const DRAFT_HEADING_CHARS = 150;
const DRAFT_INTENT_CHARS = 200;
const DRAFT_READER_CHARS = 40;
const DRAFT_QUESTION_CHARS = 160;
const DRAFT_LINE_HEADING_CHARS = 40; // per heading in the turn-context line
const DRAFT_LINE_OPEN = 6; // open sections named in the turn-context line
const DRAFT_LINE_QUESTIONS = 3; // open reader questions in the turn-context line
const DRAFT_LINE_QUESTION_CHARS = 90;
const DRAFT_BODY_WORDS = 40; // a heading with this many words below it counts as a written section
const draftKey = (docId, chatId) => `${DRAFT_PREFIX}${docId}:${chatId}`;
const flat = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
const draftPlural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// The chat a call or a turn belongs to: the turn's chat (snap.chatCtx), else the panel's. null in a side
// question (chatId null) or without a document.
function draftChat(snap) {
  const c = snap && snap.chatCtx;
  const docId = (c && c.docId) || (snap && snap.docId) || state.docId;
  const chatId = c ? c.chatId : state.chatId;
  return docId && chatId ? draftKey(docId, chatId) : null;
}

async function readDraft(key) {
  if (!key) return null;
  try {
    const v = (await chrome.storage.local.get(key))[key];
    return v && Array.isArray(v.sections) && v.sections.length ? v : null;
  } catch (e) { return null; }
}

// ---- What the document already has --------------------------------------------------------------------
// A heading compared with a plan heading: case, spacing, a leading number ("2.", "2.1", "II.") and trailing
// punctuation do not matter.
const draftHeadingKey = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim().toLowerCase()
  .replace(/^(?:\d+(?:\.\d+)*\.?|[ivxlc]+\.)\s+/, '').replace(/[\s.:;]+$/, '');

// The lines of a document as { text, heading }: the Docs API line model (src.model; table cells are body text,
// never headings) or a Markdown export (src.docText, "#" headings).
function draftDocLines(src) {
  if (src && src.model && Array.isArray(src.model.lines)) return src.model.lines.map((l) => ({ text: String(l.text || ''), heading: !!l.heading && !l.cell }));
  const text = src && typeof src.docText === 'string' ? src.docText : '';
  return text.split('\n').map((t) => { const m = /^#{1,6}\s+(.*)$/.exec(t); return m ? { text: m[1], heading: true } : { text: t, heading: false }; });
}

// The normalized headings that have at least DRAFT_BODY_WORDS words of body before the next heading.
function writtenHeadings(src) {
  const lines = draftDocLines(src);
  const out = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].heading || !lines[i].text.trim()) continue;
    let words = 0;
    for (let j = i + 1; j < lines.length && !(lines[j].heading && lines[j].text.trim()); j++) words += countWords(lines[j].text);
    if (words >= DRAFT_BODY_WORDS) out.add(draftHeadingKey(lines[i].text));
  }
  return out;
}

// The plan's sections with written (marked by draft(done) or found in the document src: { model } or { docText }).
function draftStatus(plan, src) {
  const found = src ? writtenHeadings(src) : new Set();
  return plan.sections.map((s) => ({ ...s, written: !!s.done || found.has(draftHeadingKey(s.heading)) }));
}
// The reader questions whose section is not written yet.
function openReaderQuestions(plan, status) {
  const open = new Set(status.filter((s) => !s.written).map((s) => s.heading.toLowerCase()));
  return (plan.readers || []).filter((q) => open.has(String(q.section).toLowerCase()));
}

// The document of a turn (its snapshot) or of the panel (state), for draftStatus.
const draftSnapDoc = (snap) => (snap ? { model: snap.docFormat === 'docs-api' ? snap.model : null, docText: snap.docText } : null);
const draftPanelDoc = () => ({ model: state.docFormat === 'docs-api' ? state.docModel : null, docText: state.docText });

// The line of the turn context while a plan exists (src: the turn's document; without it only draft(done) counts).
function draftLine(plan, src) {
  const st = draftStatus(plan, src);
  const n = st.length;
  const open = st.filter((s) => !s.written);
  const head = `Draft in progress: ${draftPlural(n, 'section')}, `;
  if (!open.length) return `${head}all written; call draft(end) when the text is complete.`;
  const names = open.slice(0, DRAFT_LINE_OPEN).map((s) => flat(s.heading, DRAFT_LINE_HEADING_CHARS)).join(', ') +
    (open.length > DRAFT_LINE_OPEN ? ` and ${open.length - DRAFT_LINE_OPEN} more` : '');
  const next = open[0];
  let line = `${head}${n - open.length} written; open: ${names}; next: ${next.heading}${next.intent ? ` (${next.intent})` : ''}.`;
  const qs = openReaderQuestions(plan, st);
  if (qs.length) {
    line += ' Open reader questions: ' + qs.slice(0, DRAFT_LINE_QUESTIONS).map((q) => `${q.reader}: ${flat(q.question, DRAFT_LINE_QUESTION_CHARS)} (${flat(q.section, DRAFT_LINE_HEADING_CHARS)})`).join('; ') +
      (qs.length > DRAFT_LINE_QUESTIONS ? `; ${qs.length - DRAFT_LINE_QUESTIONS} more` : '') + '.';
  }
  return line;
}

// ---- The tool --------------------------------------------------------------------------------------------
// The sections of a plan call, or an error text.
function planSections(list) {
  const bad = `Error: draft(plan) needs 1 to ${DRAFT_MAX_SECTIONS} sections, each with a heading and an intent.`;
  if (!Array.isArray(list) || !list.length || list.length > DRAFT_MAX_SECTIONS) return { error: bad };
  const sections = [];
  for (const s of list) {
    const heading = s && flat(s.heading, DRAFT_HEADING_CHARS);
    if (!heading) return { error: bad };
    if (sections.some((x) => x.heading.toLowerCase() === heading.toLowerCase())) {
      return { error: `Error: two sections have the heading «${heading}»; give each section its own heading.` };
    }
    sections.push({ heading, intent: flat(s && s.intent, DRAFT_INTENT_CHARS), done: false });
  }
  return { sections };
}

// The reader questions of a plan call (null or missing: none), each tied to a section of the new plan, or an error.
function planReaders(list, plan) {
  if (list == null) return { readers: [] };
  const bad = `Error: readers needs at most ${DRAFT_MAX_QUESTIONS} questions, each with a reader, a question and the heading of the section that answers it (or null).`;
  if (!Array.isArray(list) || list.length > DRAFT_MAX_QUESTIONS) return { error: bad };
  const readers = [];
  for (const r of list) {
    const reader = r && flat(r.reader, DRAFT_READER_CHARS);
    const question = r && flat(r.question, DRAFT_QUESTION_CHARS);
    if (!reader || !question) return { error: bad };
    const i = findSection(plan, r.section);
    if (i < 0) return { error: `Error: the question «${flat(question, 80)}» names no section of the plan; give the heading of the section that answers it.` };
    readers.push({ reader, question, section: plan.sections[i].heading });
  }
  return { readers };
}

// The section a done call names: its heading (case and spacing do not matter) or its number.
function findSection(plan, name) {
  const want = flat(name, DRAFT_HEADING_CHARS).toLowerCase();
  if (!want) return -1;
  const i = plan.sections.findIndex((s) => s.heading.toLowerCase() === want);
  if (i >= 0 || !/^\d+$/.test(want)) return i;
  const n = Number(want) - 1;
  return n >= 0 && n < plan.sections.length ? n : -1;
}

const nextText = (status) => {
  const next = status.find((s) => !s.written);
  return next ? `Next: «${next.heading}»${next.intent ? ` (${next.intent})` : ''}.` : '';
};

// draft(end) and the card's End draft: removes the plan. Returns { had } or { error }.
async function clearDraft(key) {
  const had = await readDraft(key);
  try { await chrome.storage.local.remove(key); } catch (e) { return { error: 'Error: the draft plan could not be cleared.' }; }
  if (draftCardState.key === key) draftCardState.plan = false;
  return { had: !!had };
}

async function draftTool(args, snap) {
  const key = draftChat(snap);
  if (!key) return 'Error: draft is not available here.';
  const action = args && args.action;
  if (action === 'plan') {
    const { sections, error } = planSections(args.sections);
    if (error) return error;
    const plan = { sections, readers: [], updatedAt: Date.now() };
    const rd = planReaders(args.readers, plan);
    if (rd.error) return rd.error;
    plan.readers = rd.readers;
    const had = await readDraft(key);
    if (!(await storageSet({ [key]: plan }))) return 'Error: the draft plan could not be saved.';
    const qs = plan.readers.length ? ` and ${draftPlural(plan.readers.length, 'reader question')}` : '';
    return { content: `Draft plan saved${had ? ' (it replaces the earlier one)' : ''}: ${draftPlural(sections.length, 'section')}${qs}. ${nextText(draftStatus(plan, draftSnapDoc(snap)))} Mark each section with draft(done) once it is in the document.`,
      _ok: true, _message: `plan: ${draftPlural(sections.length, 'section')}` };
  }
  if (action === 'done') {
    const plan = await readDraft(key);
    if (!plan) return 'Error: there is no draft plan in this chat; save one with draft(plan) first.';
    const i = findSection(plan, args.section);
    if (i < 0) return `Error: no section «${flat(args.section, 80)}» in the plan. Sections: ${plan.sections.map((s) => `«${s.heading}»`).join(', ')}.`;
    const s = plan.sections[i];
    if (s.done) {
      return { content: `«${s.heading}» was already marked written. ${nextText(draftStatus(plan, draftSnapDoc(snap))) || 'All sections are written; call draft(end) when the text is complete.'}`, _ok: true, _message: `done: «${s.heading}»` };
    }
    const wasComplete = draftStatus(plan, draftSnapDoc(snap)).every((x) => x.written);
    s.done = true;
    plan.updatedAt = Date.now();
    if (!(await storageSet({ [key]: plan }))) return 'Error: the draft plan could not be saved.';
    const st = draftStatus(plan, draftSnapDoc(snap));
    const n = st.length;
    const written = st.filter((x) => x.written).length;
    if (written === n && !wasComplete) snap.draftCompleted = n; // the finish hook's notice
    return { content: written === n
      ? `Marked «${s.heading}» written: all ${n} sections are written. Call draft(end) when the text is complete.`
      : `Marked «${s.heading}» written (${written} of ${n}). ${nextText(st)}`, _ok: true, _message: `done: «${s.heading}» (${written} of ${n})` };
  }
  if (action === 'end') {
    const r = await clearDraft(key);
    if (r.error) return r.error;
    return { content: r.had ? 'Draft plan cleared.' : 'There was no draft plan in this chat; nothing to clear.', _ok: true, _message: 'end' };
  }
  return 'Error: action must be "plan", "done" or "end".';
}

const DRAFT_DEF = { type: 'function', function: {
  name: 'draft',
  description: 'The outline of a long text written section by section: plan saves it, done marks a section written, end clears it.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['plan', 'done', 'end'] },
      sections: {
        anyOf: [{ type: 'array', items: { type: 'object', properties: { heading: { type: 'string' }, intent: { type: 'string' } }, required: ['heading', 'intent'], additionalProperties: false } }, { type: 'null' }],
        description: `plan: the sections in order (at most ${DRAFT_MAX_SECTIONS}), intent = what each says in a few words; otherwise null.`,
      },
      section: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'done: the heading just written; otherwise null.' },
      readers: {
        anyOf: [{ type: 'array', items: { type: 'object', properties: { reader: { type: 'string' }, question: { type: 'string' }, section: { type: 'string' } }, required: ['reader', 'question', 'section'], additionalProperties: false } }, { type: 'null' }],
        description: 'plan: the kept readers\' questions, each with the section that answers it; otherwise null.',
      },
    },
    required: ['action', 'sections', 'section', 'readers'],
    additionalProperties: false,
  },
} };

// Offered in Auto turns with the Docs API, where the long text is written with insert_after_line / replace_section.
const offerDraft = (mode, snap) => !!snap && !snap.side && apiEditing(mode, snap);

function draftSummary(name, args) {
  const a = args || {};
  if (a.action === 'plan') return Array.isArray(a.sections) ? `plan: ${draftPlural(a.sections.length, 'section')}` : 'plan';
  if (a.action === 'done') return `done: «${flat(a.section, 60)}»`;
  return a.action ? String(a.action) : '';
}

// Runs fn once the panel is no longer busy with a turn (polls; gives up after about a minute), so the notice
// stays below the turn's final re-render.
function whenDraftIdle(fn, tries = 1200) {
  if (!state.busy) { fn(); return; }
  if (tries > 0) setTimeout(() => whenDraftIdle(fn, tries - 1), 50);
}

// ---- The checklist card ----------------------------------------------------------------------------------
// One card per chat while its plan exists, at the end of the chat: drawn again at every turn end (finish hook) and
// whenever a re-render of the idle chat drops it (a chat switch, a reload: the observer below). Never stored.
const draftCardState = { key: null, plan: false };
let draftCardSeq = 0;
const panelDraftKey = () => (state.docId && state.chatId ? draftKey(state.docId, state.chatId) : null);
const draftCardShown = () => !!el.chat && [...el.chat.querySelectorAll('.draft-card')].some((c) => c.isConnected);

function draftCard(plan, key) {
  const st = draftStatus(plan, draftPanelDoc());
  const written = st.filter((s) => s.written).length;
  const next = st.find((s) => !s.written);
  const qs = openReaderQuestions(plan, st);
  const d = document.createElement('div');
  d.className = 'tool-card draft-card';
  d.innerHTML = `<div class="dc-title">🗂 Draft plan: ${written} of ${draftPlural(st.length, 'section')} written</div>` +
    `<ul class="dc-list">${st.map((s) => `<li${s.written ? ' class="done"' : ''}>${s.written ? '☑' : '☐'} ${escapeHtml(s.heading)}</li>`).join('')}</ul>` +
    `<div class="dc-next">${next ? `Next: ${escapeHtml(next.heading)}${next.intent ? ` (${escapeHtml(next.intent)})` : ''}` : 'All sections are written.'}</div>` +
    (qs.length ? `<div class="dc-label">Open reader questions</div><ul class="dc-questions">${qs.map((q) => `<li>${escapeHtml(q.reader)}: ${escapeHtml(q.question)} <span class="dc-where">(${escapeHtml(q.section)})</span></li>`).join('')}</ul>` : '') +
    '<div class="tool-actions"><button class="btn small" type="button" data-draft="end" title="Clear the draft plan of this chat">End draft</button></div>';
  d.addEventListener('click', (ev) => {
    const b = ev.target && ev.target.closest ? ev.target.closest('button[data-draft="end"]') : null;
    if (b) endDraftFromCard(key);
  });
  return d;
}

// Draws the card of the open chat again (or removes it when the chat has no plan). Returns the card or null.
async function refreshDraftCard() {
  const seq = ++draftCardSeq;
  const key = panelDraftKey();
  const plan = await readDraft(key);
  if (seq !== draftCardSeq || !el.chat) return null;
  for (const c of [...el.chat.querySelectorAll('.draft-card')]) c.remove();
  draftCardState.key = key;
  draftCardState.plan = !!plan;
  return plan ? appendToChat(draftCard(plan, key), false) : null;
}

// End draft on the card: the same as draft(end). Not while an answer runs (its draft calls would race).
async function endDraftFromCard(key = panelDraftKey()) {
  if (state.busy) { addNotice('Wait for the answer to finish, then end the draft.'); return false; }
  const r = await clearDraft(key);
  if (r.error) { addNotice('The draft plan could not be cleared. Try again.'); return false; }
  await refreshDraftCard();
  addNotice('Draft ended: the plan of this chat is cleared.');
  return true;
}

// A re-render of the idle chat dropped the card, or the open chat changed: draw it again.
function onDraftChatChange() {
  if (state.busy) return;
  const key = panelDraftKey();
  if (key === draftCardState.key && (!draftCardState.plan || draftCardShown())) return;
  refreshDraftCard();
}
if (typeof MutationObserver === 'function' && el.chat) new MutationObserver(onDraftChatChange).observe(el.chat, { childList: true });

// ---- Registration ----------------------------------------------------------------------------------------
registerTools([DRAFT_DEF], {
  offer: offerDraft,
  reading: true, // no document edit: a quiet action-log row, no card, no edit gate
  run: (name, args, snap) => draftTool(args, snap),
  summary: draftSummary,
  icon: '🗂',
  prompt: [{ section: 'edit', line: '- draft(action, sections, section, readers): for a text over about two pages, first name 3–4 readers of its type (paper: reviewer 2, methods expert, newcomer; grant: programme officer, neighbouring-field reviewer; thesis: examiner, future student) with 1–2 questions each and ask_user which one to drop; save the outline with draft(plan), the kept questions as readers; write one section per edit (insert_after_line or replace_section), mark it with draft(done); draft(end) when the text is complete.' }],
});
registerTurnHook('beforeTurn', async (mode, snap) => {
  if (!offerDraft(mode, snap)) return '';
  const plan = await readDraft(draftChat(snap));
  if (!plan) return '';
  snap.draftOpen = draftStatus(plan, draftSnapDoc(snap)).filter((s) => !s.written).length; // for the finish notice
  return draftLine(plan, draftSnapDoc(snap));
});
// The notice when the last section got written in this turn (marked, or found in the document), and the card.
registerTurnHook('finish', async (userMsg, snap) => {
  const docId = snap && snap.docId;
  let n = snap && snap.draftCompleted;
  if (!n && snap && snap.draftOpen > 0) {
    const plan = await readDraft(draftChat(snap));
    const st = plan ? draftStatus(plan, draftPanelDoc()) : [];
    if (st.length && st.every((s) => s.written)) n = st.length;
  }
  whenDraftIdle(() => {
    if (state.docId !== docId) return;
    if (n) addNotice(`Draft complete: ${draftPlural(n, 'section')}`, { sticky: true });
    refreshDraftCard();
  });
});
