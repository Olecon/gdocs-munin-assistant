'use strict';
// Module paper-card.js: the paper card, a one-time extraction the user confirms. In the Document instructions section
// Build paper card (Rebuild) runs one quiet request on the document alone (the document pass "card" of request.js:
// the whole numbered text or its outline plus the reading tools, the task PAPER_CARD_TASK of prompts.js, no chat
// history); parsePaperCard reads the answer; the card is shown as editable fields with Save / Discard. The saved card
// (chrome.storage.local, paperCardKey(docId)) goes into every user message's turn context as a compact <paper_card>
// line (a beforeTurn hook; never into the static head). It never updates itself: when the document changed a lot
// since the build (paperCardStale: the share of changed lines), the section says so next to Rebuild.
// paperCardNumbers(docId) gives the card's headline numbers to other checks (the provenance check may treat them as known).
/* global addError, addNotice, buildTurnContext, docStatusText, fetchDocText, isDocPass, paperCardKey, parseJsonLoose, registerTurnHook,
   resetDocsApiTurn, setBusy, setStatus, settleQueue, snapshotDocument, state, takeSnapshot, toolLoop */
/* exported PAPER_CARD_FIELDS, parsePaperCard, paperCardFacts, paperCardStale, paperCardBlock, paperCardLine, readPaperCard,
   writePaperCard, loadPaperCard, paperCardNumbers, renderPaperCardSection, buildPaperCard, savePaperCard, discardPaperCard,
   cardFromFields */

const PAPER_CARD_FIELDS = [
  ['question', 'Research question'], ['population_or_system', 'Population or system'], ['design', 'Design'],
  ['comparator', 'Comparator'], ['outcomes', 'Outcomes'], ['main_claims', 'Main claims (one per line)'],
  ['headline_numbers', 'Headline numbers (one per line: value: meaning)'],
];
const PAPER_CARD_TEXT_FIELDS = PAPER_CARD_FIELDS.slice(0, 5).map((f) => f[0]);
const PAPER_CARD_MAX = { text: 200, claims: 4, claim: 160, numbers: 6, value: 30, meaning: 90, block: 640 };
// Stale: at least this share of the lines it was built from changed (and at least PAPER_CARD_STALE_MIN lines).
const PAPER_CARD_STALE_SHARE = 0.2;
const PAPER_CARD_STALE_MIN = 5;
const PAPER_CARD_ALIASES = {
  question: ['question', 'research_question', 'aim'], population_or_system: ['population_or_system', 'population', 'system', 'sample', 'subject'],
  design: ['design', 'study_design', 'method'], comparator: ['comparator', 'comparison', 'control'], outcomes: ['outcomes', 'outcome', 'measures'],
  main_claims: ['main_claims', 'claims', 'mainClaims'], headline_numbers: ['headline_numbers', 'numbers', 'key_numbers', 'headlineNumbers'],
};

// ---- Parsing ------------------------------------------------------------------------------------------------
const pcClip = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };
const pcLine = (v) => { const m = /\d+/.exec(String(v == null ? '' : v)); const n = m ? Number(m[0]) : NaN; return Number.isFinite(n) && n > 0 ? n : null; };
const pcPick = (o, field) => { for (const k of PAPER_CARD_ALIASES[field]) if (o[k] != null) return o[k]; return undefined; };
const pcText = (v) => (Array.isArray(v) ? v.map(pcText).filter(Boolean).join('; ') : v && typeof v === 'object' ? pcText(v.text || v.value || '') : typeof v === 'number' ? String(v) : typeof v === 'string' ? v : '');
// A claim from the model: { text, line } or a string ("… (line 12)").
function pcClaim(v) {
  if (typeof v === 'string') return pcClaimFromText(v);
  if (!v || typeof v !== 'object') return null;
  const text = pcClip(v.text || v.claim || '', PAPER_CARD_MAX.claim);
  return text ? { text, line: pcLine(v.line) } : null;
}
function pcNumber(v) {
  if (typeof v === 'string' || typeof v === 'number') return pcNumberFromText(String(v));
  if (!v || typeof v !== 'object') return null;
  const value = pcClip(v.value != null ? v.value : v.number, PAPER_CARD_MAX.value);
  return value ? { value, meaning: pcClip(v.meaning || v.what || v.description || '', PAPER_CARD_MAX.meaning), line: pcLine(v.line) } : null;
}
// "text (line 12)" → { text, line }.
function pcClaimFromText(s) {
  const m = /^(.*?)\s*\((?:line|L)\s*(\d+)\)\s*$/i.exec(String(s).trim());
  const text = pcClip(m ? m[1] : s, PAPER_CARD_MAX.claim);
  return text ? { text, line: m ? Number(m[2]) : null } : null;
}
// "42%: response rate (line 30)" → { value, meaning, line }.
function pcNumberFromText(s) {
  const c = pcClaimFromText(s);
  if (!c) return null;
  const at = c.text.indexOf(': ');
  const value = pcClip(at > 0 ? c.text.slice(0, at) : c.text, PAPER_CARD_MAX.value);
  return value ? { value, meaning: at > 0 ? pcClip(c.text.slice(at + 2), PAPER_CARD_MAX.meaning) : '', line: c.line } : null;
}
const pcList = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
// A card in the stored shape from any object with its fields (aliases accepted; strings for list items too).
function pcNormalize(o) {
  const card = {};
  for (const f of PAPER_CARD_TEXT_FIELDS) card[f] = pcClip(pcText(pcPick(o, f)), PAPER_CARD_MAX.text);
  card.main_claims = pcList(pcPick(o, 'main_claims')).map(pcClaim).filter(Boolean).slice(0, PAPER_CARD_MAX.claims);
  card.headline_numbers = pcList(pcPick(o, 'headline_numbers')).map(pcNumber).filter(Boolean).slice(0, PAPER_CARD_MAX.numbers);
  return card;
}
const pcEmpty = (c) => !c || (PAPER_CARD_TEXT_FIELDS.every((f) => !c[f]) && !c.main_claims.length && !c.headline_numbers.length);
// The model's answer as { ok, card } (ok false with error when no card could be read from it).
function parsePaperCard(raw) {
  const v = parseJsonLoose(raw);
  const o = Array.isArray(v) ? v[0] : v;
  const card = o && typeof o === 'object' ? pcNormalize(o.paper_card && typeof o.paper_card === 'object' ? o.paper_card : o) : null;
  if (pcEmpty(card)) return { ok: false, error: 'The card did not come back as JSON. Try Rebuild.', raw: String(raw == null ? '' : raw) };
  return { ok: true, card };
}

// ---- What it was built from, and staleness ----------------------------------------------------------------------
// A short hash (FNV-1a, base 36) of each non-empty line, normalized for spaces.
function pcHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}
const pcHashLines = (text) => String(text == null ? '' : text).split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).map(pcHash);
// The facts stored with a card: the document's size and the hashes of its lines when the card was built.
const paperCardFacts = (text) => ({ chars: String(text == null ? '' : text).length, hashes: pcHashLines(text) });
// Whether the document changed a lot since the card was built: the lines no longer there, or new ones, make up at
// least PAPER_CARD_STALE_SHARE of the lines it was built from (and at least PAPER_CARD_STALE_MIN lines).
function paperCardStale(facts, text) {
  if (!facts || !Array.isArray(facts.hashes) || text == null) return false;
  const now = new Map();
  for (const h of pcHashLines(text)) now.set(h, (now.get(h) || 0) + 1);
  let kept = 0;
  for (const h of facts.hashes) { const n = now.get(h); if (n) { kept++; now.set(h, n - 1); } }
  const gone = facts.hashes.length - kept;
  let added = 0;
  for (const n of now.values()) added += n;
  const changed = Math.max(gone, added);
  return changed >= PAPER_CARD_STALE_MIN && changed >= PAPER_CARD_STALE_SHARE * Math.max(facts.hashes.length, 1);
}

// ---- The turn-context block ---------------------------------------------------------------------------------
const pcLineRef = (n) => (n ? ` (L${n})` : '');
// The <paper_card> line of the turn context (about 150 tokens at most), or '' for an empty card.
function paperCardBlock(card, stale = false) {
  if (pcEmpty(card)) return '';
  const parts = [];
  const names = { question: 'Question', population_or_system: 'Population or system', design: 'Design', comparator: 'Comparator', outcomes: 'Outcomes' };
  for (const f of PAPER_CARD_TEXT_FIELDS) if (card[f]) parts.push(`${names[f]}: ${pcClip(card[f], 160)}`);
  if (card.main_claims.length) parts.push(`Main claims: ${card.main_claims.map((c) => pcClip(c.text, 120) + pcLineRef(c.line)).join('; ')}`);
  if (card.headline_numbers.length) parts.push(`Headline numbers: ${card.headline_numbers.map((x) => `${x.value}${x.meaning ? ' ' + pcClip(x.meaning, 50) : ''}${pcLineRef(x.line)}`).join('; ')}`);
  const attrs = stale ? ' note="built before large changes; may be out of date"' : '';
  return `<paper_card${attrs}>${pcClip(parts.join(' | '), PAPER_CARD_MAX.block)}</paper_card>`;
}

// ---- Storage ----------------------------------------------------------------------------------------------------
// The saved card of the current document ({ docId, entry }; entry: { card, facts, builtAt, savedAt } or null).
const paperCards = { docId: null, entry: null };
async function readPaperCard(docId) {
  if (!docId) return null;
  try {
    const v = (await chrome.storage.local.get(paperCardKey(docId)))[paperCardKey(docId)];
    return v && typeof v === 'object' && v.card && !pcEmpty(pcNormalize(v.card)) ? { ...v, card: pcNormalize(v.card) } : null;
  } catch (e) {
    return null;
  }
}
// Stores (or, for an empty card, removes) a document's card; the cache follows.
async function writePaperCard(docId, entry) {
  if (!entry || pcEmpty(entry.card)) await chrome.storage.local.remove(paperCardKey(docId));
  else await chrome.storage.local.set({ [paperCardKey(docId)]: entry });
  const saved = entry && !pcEmpty(entry.card) ? entry : null;
  if (paperCards.docId === docId || docId === state.docId) { paperCards.docId = docId; paperCards.entry = saved; }
  return saved;
}
async function loadPaperCard(docId) {
  const entry = await readPaperCard(docId);
  if (docId !== state.docId && state.docId) return entry;
  paperCards.docId = docId;
  paperCards.entry = entry;
  if (paperForm.docId !== docId) Object.assign(paperForm, { docId, draft: null, facts: null, error: '' });
  return entry;
}
// The headline numbers of a document's saved card (values as written), for checks that treat them as known.
function paperCardNumbers(docId = state.docId) {
  const e = paperCards.docId === docId ? paperCards.entry : null;
  return e ? e.card.headline_numbers.map((x) => x.value) : [];
}
// The turn's <paper_card> line (beforeTurn): not in document passes (/review stays independent of it).
async function paperCardLine(mode, snap) {
  if (!snap || !snap.docId || isDocPass(mode)) return '';
  const entry = paperCards.docId === snap.docId ? paperCards.entry : await readPaperCard(snap.docId);
  return entry ? paperCardBlock(entry.card, paperCardStale(entry.facts, snap.docText)) : '';
}
registerTurnHook('beforeTurn', paperCardLine);
registerTurnHook('panelDoc', (docId) => loadPaperCard(docId).then(() => { if (pcSectionOpen()) renderPaperCardSection(); }));

// ---- The section ------------------------------------------------------------------------------------------------
// paperForm: the card being looked at: draft (a build not saved yet, with the facts of its document), the error of the
// last build, building while it runs.
const paperForm = { docId: null, draft: null, facts: null, error: '', building: false };
const pcEl = (id) => document.getElementById(id);
const pcSectionOpen = () => { const s = pcEl('instructions'); return !!s && !s.classList.contains('hidden'); };
// The text a field shows for editing.
function pcFieldText(card, f) {
  if (f === 'main_claims') return card.main_claims.map((c) => c.text + (c.line ? ` (line ${c.line})` : '')).join('\n');
  if (f === 'headline_numbers') return card.headline_numbers.map((x) => `${x.value}${x.meaning ? ': ' + x.meaning : ''}${x.line ? ` (line ${x.line})` : ''}`).join('\n');
  return card[f] || '';
}
// The card from the fields' texts ({ field: text }).
function cardFromFields(values) {
  const lines = (t) => String(t || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const card = {};
  for (const f of PAPER_CARD_TEXT_FIELDS) card[f] = pcClip(values[f], PAPER_CARD_MAX.text);
  card.main_claims = lines(values.main_claims).map(pcClaimFromText).filter(Boolean).slice(0, PAPER_CARD_MAX.claims);
  card.headline_numbers = lines(values.headline_numbers).map(pcNumberFromText).filter(Boolean).slice(0, PAPER_CARD_MAX.numbers);
  return card;
}
function pcReadFields() {
  const values = {};
  for (const [f] of PAPER_CARD_FIELDS) { const t = pcEl('paperCard_' + f); values[f] = t ? t.value : ''; }
  return values;
}
// Draws the paper card part of the Document instructions section from the saved card, the draft and the last error.
function renderPaperCardSection() {
  const box = pcEl('paperCardFields');
  if (!box) return;
  const saved = paperCards.docId === state.docId ? paperCards.entry : null;
  const draft = paperForm.docId === state.docId ? paperForm.draft : null;
  const shown = draft || (saved && saved.card);
  box.textContent = '';
  if (shown) {
    for (const [f, label] of PAPER_CARD_FIELDS) {
      const l = document.createElement('label');
      l.textContent = label;
      const t = document.createElement('textarea');
      t.id = 'paperCard_' + f;
      t.className = 'instructions-text paper-card-field';
      t.rows = f === 'main_claims' || f === 'headline_numbers' ? 3 : 2;
      t.style.minHeight = '0';
      t.value = pcFieldText(shown, f);
      l.appendChild(t);
      box.appendChild(l);
    }
  }
  box.classList.toggle('hidden', !shown);
  const build = pcEl('paperCardBuild');
  build.textContent = paperForm.building ? 'Building…' : shown ? 'Rebuild' : 'Build paper card';
  build.disabled = paperForm.building;
  pcEl('paperCardSave').classList.toggle('hidden', !shown);
  pcEl('paperCardDiscard').classList.toggle('hidden', !shown);
  const stale = !draft && saved && paperCardStale(saved.facts, state.docText);
  pcEl('paperCardStale').classList.toggle('hidden', !stale);
  const hint = pcEl('paperCardHint');
  const error = paperForm.docId === state.docId ? paperForm.error : '';
  hint.textContent = error || (draft ? 'Check and correct the card, then Save. Nothing is used before you save it.'
    : saved ? 'Sent with every message (about 150 tokens). It never updates itself: Rebuild when the paper changes.'
      : 'Question, design, main claims and headline numbers, extracted once; you check them before they are sent with every message.');
  hint.classList.toggle('warn', !!error);
}

// Build paper card / Rebuild: one quiet request on the document alone (no chat history; the chat is not touched).
// The result is a draft until Save. Returns the draft card, or null.
async function buildPaperCard() {
  if (state.busy) { setStatus('Wait for the answer to finish, then build the card', true); return null; }
  if (!state.docId) { setStatus('Open a Google Docs document first', true); return null; }
  const snap = takeSnapshot();
  if (!snap.cfg.apiKey) { addError(`No ${snap.prov.label} API key set.`, true); return null; }
  const docId = state.docId;
  setBusy(true);
  const abort = new AbortController();
  state.abort = abort; // Stop works while it runs
  snap.signal = abort.signal;
  Object.assign(paperForm, { docId, error: '', building: true });
  renderPaperCardSection();
  let card = null;
  try {
    setStatus('Reading the document…');
    resetDocsApiTurn();
    await fetchDocText();
    snapshotDocument(snap);
    snap.chatCtx = { docId, chatId: null, messages: [] };
    if (snap.docText == null) throw new Error(snap.docError || 'the document text is unavailable');
    const history = [{ role: 'user', content: 'Build the paper card.', _context: buildTurnContext('card', snap, null) }];
    await toolLoop('card', snap, abort.signal, { messages: history, quiet: true, request: { history }, waiting: `Building the paper card with ${snap.prov.label}…` });
    const last = [...history].reverse().find((m) => m.role === 'assistant' && m.content);
    const res = parsePaperCard(last ? last.content : '');
    if (state.docId !== docId) return null;
    if (!res.ok) paperForm.error = res.error;
    else {
      card = res.card;
      Object.assign(paperForm, { draft: card, facts: paperCardFacts(snap.docText) });
    }
  } catch (e) {
    paperForm.error = abort.signal.aborted || e.name === 'AbortError' ? 'Stopped. Nothing was built.' : `Could not build the paper card: ${e.message || e}`;
  } finally {
    state.abort = null;
    paperForm.building = false;
    setBusy(false);
    settleQueue('card'); // like the self-test: a message typed meanwhile goes back into the input box
    setStatus(docStatusText(), state.docText == null);
    renderPaperCardSection();
  }
  return card;
}
// Save: the fields as they are now (a draft keeps the facts of its build; an edited saved card keeps its own). All
// fields empty removes the card.
async function savePaperCard() {
  const docId = state.docId;
  if (!docId) return null;
  const card = cardFromFields(pcReadFields());
  const saved = paperCards.docId === docId ? paperCards.entry : null;
  const draft = paperForm.docId === docId && paperForm.draft;
  const now = Date.now();
  const entry = pcEmpty(card) ? null : {
    card, facts: draft ? paperForm.facts : saved ? saved.facts : paperCardFacts(state.docText),
    builtAt: draft || !saved ? now : saved.builtAt, savedAt: now,
  };
  let result;
  try { result = await writePaperCard(docId, entry); } catch (e) {
    addError('Could not save the paper card: ' + e.message);
    return null;
  }
  Object.assign(paperForm, { draft: null, facts: null, error: '' });
  renderPaperCardSection();
  addNotice(result ? `Paper card saved. It is sent with every message from the next one${state.busy ? ' (not with the answer that is running)' : ''}.` : 'Paper card removed.');
  return result;
}
// Discard: drops the draft or the unsaved edits; the saved card (if any) stays.
function discardPaperCard() {
  Object.assign(paperForm, { draft: null, facts: null, error: '' });
  renderPaperCardSection();
}

for (const [id, fn] of [['paperCardBuild', buildPaperCard], ['paperCardSave', savePaperCard], ['paperCardDiscard', discardPaperCard]]) {
  const b = pcEl(id);
  if (b) b.addEventListener('click', () => { fn(); });
}
