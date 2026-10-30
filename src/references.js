'use strict';
// Module references.js: citations and the bibliography section: the grant of the lookups (the chat's access card,
// requestReferencesAccess; state.settings.references caches it), the tools find_reference (reading) and cite (writing,
// Docs API; offered with the grant or when the message or the document instructions mention references), the per-document
// store of cited items (citationsKey), the References section, numeric renumbering, and undo (kind 'cite').
// Citations and the bibliography are plain text: Zotero's own Docs plugin does not see them. The composer's "@"
// autocomplete (slash.js) picks Zotero items through zoteroPickItems / zoteroToken; zoteroMentionsLine turns the picks
// in a sent message into a turn-context line (the beforeTurn hook below), so cite needs no search round.
/* exported citationsInRanges, referencesOn, requestReferencesAccess, referencesAllowed, referencesRecheck, refsOffered, refsMentioned,
   grantReferences, withReferences, zoteroAtReady, REFS_DENIED_TEXT, zoteroPickItems, zoteroToken, zoteroMentionsLine, ZOTERO_PICK_MAX, ZOTERO_TOKEN_RE */
/* global addNotice, anchorMatches, confirmOpen, REFERENCES_KEY, REFERENCES_ORIGINS, lastSentText, apiEditing, changedLinesReport, citationsKey, cslSummary, commitSequence, commonEdges,
   crossrefBib, crossrefMeta, docsBatchUpdate, fetchDocModel, finishEdit, findFlexible, GATE_REPLACE_CHARS, gateEdit, hitLines,
   indexAtOffset, indexRange, isClosing, itemSummary, lineAtIndex, lineAtOffset, makeAnchor, notFoundError, oneLine,
   parseDoi, rangeLabel, registerTools, registerTurnHook, registerUndoHandler, reqDelete, reqInsert, reqStyle,
   reqBulletsOff, showText, state, writeError, ZOTERO_SETUP, zoteroFormat, zoteroSearch, zoteroStatus */

const CITE_DEFAULT_STYLE = 'apa';
const CITE_LOCALE = 'en-US';
const CITE_MAX_IDS = 10;
const MARK_CONTEXT = 20; // characters before a citation kept to find it again (like an undo anchor)
// Numeric CSL styles known without asking Zotero (a style Zotero formats shows itself as numeric).
const NUMERIC_STYLES = new Set(['ieee', 'vancouver', 'nature', 'science', 'american-chemical-society', 'american-medical-association',
  'american-institute-of-physics', 'american-physics-society', 'royal-society-of-chemistry', 'national-library-of-medicine',
  'elsevier-with-titles', 'springer-basic-brackets', 'cell-numeric', 'bmj', 'the-lancet', 'plos', 'pnas']);
// Headings of an existing bibliography section (compared lowercased, without a trailing colon).
const BIB_HEADINGS = ['references', 'bibliography', 'literature', 'works cited', 'literature cited', 'список литературы', 'литература'];
const BIB_TITLE = 'References';

const referencesOn = () => !!(state.settings && state.settings.references);

// ---- The grant: the access card in the chat -----------------------------------------------------------------------
// The lookups (Zotero's local API, Crossref, OpenAlex) need Chrome's optional host permissions. Nothing asks for them
// up front: a reference tool, /check's Allow lookups or the "@" picker asks on a card in the chat, whose Allow calls
// chrome.permissions.request from the click (the user gesture it needs). The grant is stored (REFERENCES_KEY) and
// counts while Chrome still grants every origin (loadSettings; referencesRecheck after a failed lookup), so revoking the
// access in chrome://extensions brings the card back.
const REFS_ACCESS_TEXT = 'The assistant wants to look up references through Zotero (on this computer), Crossref and OpenAlex.';
const REFS_DENIED_TEXT = 'The user did not allow reference lookups in this message.';
async function setReferencesGranted(on) {
  state.settings.references = !!on;
  try { await chrome.storage.local.set({ [REFERENCES_KEY]: !!on }); } catch (e) { /* the cache still holds it */ }
}
// Asks Chrome; call it first thing in a click. A promise of whether all origins are granted (and stored).
function grantReferences() {
  let req;
  try { req = chrome.permissions.request({ origins: REFERENCES_ORIGINS }); } catch (e) { return Promise.resolve(false); }
  return Promise.resolve(req).then(async (ok) => {
    if (ok) await setReferencesGranted(true);
    return !!ok;
  }, () => false);
}
// After a failed lookup: whether Chrome still grants the origins; a revoked grant is forgotten (the card asks again).
async function referencesRecheck() {
  let ok = false;
  try { ok = !!(await chrome.permissions.contains({ origins: REFERENCES_ORIGINS })); } catch (e) { ok = false; }
  if (!ok && referencesOn()) await setReferencesGranted(false);
  return ok && referencesOn();
}
// The access card: resolves true once granted (at once when it already is), false for Not now, a refusal by Chrome or
// Stop (signal). reason: a short sentence after the card's text. ui: the tool call's card holder (confirmOpen).
async function requestReferencesAccess(reason, { signal = null, ui = {} } = {}) {
  if (referencesOn()) return true;
  const text = reason ? `${REFS_ACCESS_TEXT} ${reason}` : REFS_ACCESS_TEXT;
  const d = await confirmOpen({ tool: 'References', title: 'Zotero, Crossref, OpenAlex', kind: 'access', icon: '📚', text, onAllow: grantReferences }, signal, ui);
  return d === 'accept' && referencesOn();
}
// Once per turn (snap.refsAccess): a second need in the same turn gets the first answer without a card. A quiet turn
// (the self-test) has nobody to ask.
function referencesAllowed(snap, ui, reason) {
  if (referencesOn()) return Promise.resolve(true);
  if (!snap || snap.quiet) return Promise.resolve(false);
  if (!snap.refsAccess) snap.refsAccess = requestReferencesAccess(reason, { signal: snap.signal || null, ui });
  return snap.refsAccess;
}
// A reference tool's run behind the grant: the denial is the model-facing text (no retry: the turn's answer stands);
// a failed lookup checks whether the permissions are still there.
async function withReferences(snap, ui, reason, run) {
  if (!(await referencesAllowed(snap, ui, reason))) return { content: REFS_DENIED_TEXT, _ok: false, _message: 'Reference lookups not allowed' };
  const r = await run();
  const failed = typeof r === 'string' ? r.startsWith('Error') : !!r && r._ok === false;
  if (failed) await referencesRecheck();
  return r;
}

// ---- Offering the tools ---------------------------------------------------------------------------------------------
// With the grant the reference tools are always offered; without it only when the user's message or the document
// instructions mention references, so an unrelated turn's prompt does not grow (stems in English and Russian).
const REFS_WORDS_RE = /\b(?:references?|citations?|cit(?:e|es|ed|ing)|bibliograph\w*|doi|zotero|crossref)\b|литератур|ссылк|цитир|библиограф|источник/i;
const refsMentioned = (text) => REFS_WORDS_RE.test(String(text || ''));
// Fixed once per turn by the beforeTurn hook (snap.refsOffer), so every round offers the same tools; without it
// (a snapshot no turn prepared) asked now.
function refsOffered(snap) {
  if (snap && typeof snap.refsOffer === 'boolean') return snap.refsOffer;
  return referencesOn() || refsMentioned(lastSentText()) || refsMentioned(snap && snap.docInstructions);
}

// ---- The store of cited items (one key per document) ------------------------------------------------------
// { style, locale, numeric, rev (counts the writes; undo restores the previous store only when nothing wrote
// since), items: { id: { src: 'zotero' | 'doi', key | doi, label (in-text citation of the item alone), bib,
// short ("Smith & Lee 2020") } }, order: [ids by first citation (numeric: the numbers)], marks: [{ ids, label,
// before (the MARK_CONTEXT characters before the label when it was written) }] }.
const emptyStore = () => ({ style: CITE_DEFAULT_STYLE, locale: CITE_LOCALE, numeric: false, rev: 0, items: {}, order: [], marks: [] });
function sanitizeStore(v) {
  const s = emptyStore();
  if (!v || typeof v !== 'object') return s;
  if (typeof v.style === 'string' && v.style) s.style = v.style;
  if (typeof v.locale === 'string' && v.locale) s.locale = v.locale;
  s.numeric = v.numeric === true;
  s.rev = Number.isInteger(v.rev) ? v.rev : 0;
  if (v.items && typeof v.items === 'object') for (const [id, it] of Object.entries(v.items)) if (it && typeof it.bib === 'string') s.items[id] = it;
  s.order = Array.isArray(v.order) ? v.order.filter((id) => s.items[id]) : [];
  s.marks = Array.isArray(v.marks) ? v.marks.filter((m) => m && Array.isArray(m.ids) && typeof m.label === 'string') : [];
  return s;
}
const clone = (v) => JSON.parse(JSON.stringify(v));
// The stores read last, for the turn context's note (docNote is synchronous).
const citeCache = new Map();
async function loadCiteStore(docId) {
  let got = {};
  try { got = await chrome.storage.local.get(citationsKey(docId)); } catch (e) { /* defaults */ }
  const s = sanitizeStore(got[citationsKey(docId)]);
  citeCache.set(docId, s);
  return s;
}
async function saveCiteStore(docId, store) {
  citeCache.set(docId, store);
  try { await chrome.storage.local.set({ [citationsKey(docId)]: store }); } catch (e) { /* the document keeps the text */ }
}

// ---- Ids and items --------------------------------------------------------------------------------------
// "zotero:ABCD1234", "doi:10.1000/x" (a bare DOI is taken too). null when invalid.
function parseCiteId(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const z = /^zotero:([A-Z0-9]{8})$/i.exec(s);
  if (z) return { id: 'zotero:' + z[1].toUpperCase(), src: 'zotero', key: z[1].toUpperCase() };
  const doi = /^(doi:|https?:\/\/(dx\.)?doi\.org\/)?10\./i.test(s) ? parseDoi(s) : null;
  return doi ? { id: 'doi:' + doi, src: 'doi', doi } : null;
}

// "Smith", "Smith & Lee", "Smith et al." of family names.
function whoText(fams) {
  if (!fams.length) return 'Anonymous';
  return fams.length === 1 ? fams[0] : fams.length === 2 ? `${fams[0]} & ${fams[1]}` : `${fams[0]} et al.`;
}
const zoteroFamilies = (d) => (d.creators || []).filter((c) => !c.creatorType || c.creatorType === 'author' || c.creatorType === 'editor')
  .map((c) => c.lastName || c.name || '').filter(Boolean);
const zoteroYear = (d) => (/\b(\d{4})\b/.exec(d.date || '') || [])[1] || 'n.d.';
const cslFamilies = (m) => (m.author || m.editor || []).map((a) => a.family || a.literal || a.name || '').filter(Boolean);
const cslYear = (m) => ((((m.issued || m.published || {})['date-parts'] || [[]])[0] || [])[0]) || 'n.d.';

const zoteroProblem = (st) => (st.reason === 'off'
  ? `Zotero is running but its local API is off. Ask the user to turn on ${ZOTERO_SETUP}`
  : st.reason === 'absent'
  ? `Zotero is not running (nothing answers on localhost:23119). Ask the user to start Zotero 7 with ${ZOTERO_SETUP} turned on`
  : `Zotero's local API failed (${st.message}). Ask the user to restart Zotero`);

// The items of ids formatted in the store's style: { items: { id: item }, numbered } (numbered: the style showed
// itself as numeric). Zotero items need Zotero running; DOIs go to Crossref. Throws a readable Error.
async function formatItems(parsed, style, locale) {
  const items = {};
  let numbered = false;
  const zot = parsed.filter((p) => p.src === 'zotero');
  if (zot.length) {
    const st = await zoteroStatus();
    if (!st.ok) throw new Error(zoteroProblem(st));
    const got = await zoteroFormat(zot.map((p) => p.key), style, locale);
    for (const p of zot) {
      const it = got[p.key];
      if (!it) throw new Error(`Zotero has no item ${p.key}; find it again with find_reference`);
      if (!it.bib) throw new Error(`Zotero did not format ${p.id} in the style "${style}"; check the style id (e.g. apa, ieee, vancouver)`);
      numbered = numbered || it.numbered;
      items[p.id] = { src: 'zotero', key: p.key, label: it.citation || `(${whoText(zoteroFamilies(it.data))}, ${zoteroYear(it.data)})`, bib: it.bib, short: `${whoText(zoteroFamilies(it.data))} ${zoteroYear(it.data)}` };
    }
  }
  await Promise.all(parsed.filter((p) => p.src === 'doi').map(async (p) => {
    const [meta, b] = await Promise.all([crossrefMeta(p.doi), crossrefBib(p.doi, style, locale)]);
    numbered = numbered || b.numbered;
    const who = whoText(cslFamilies(meta));
    items[p.id] = { src: 'doi', doi: p.doi, label: `(${who}, ${cslYear(meta)})`, bib: b.bib, short: `${who} ${cslYear(meta)}` };
  }));
  return { items, numbered };
}

// ---- Labels and numbering ------------------------------------------------------------------------------------
const innerLabel = (l) => String(l).trim().replace(/^\((.*)\)$/, '$1');
// The in-text label of a citation of ids: "(Smith, 2020; Lee, 2021)" or "[1, 3]".
function markLabel(store, ids, order) {
  if (store.numeric) return '[' + ids.map((id) => order.indexOf(id) + 1).filter((n) => n > 0).sort((a, b) => a - b).join(', ') + ']';
  return '(' + ids.map((id) => innerLabel(store.items[id].label)).join('; ') + ')';
}
// The entries of the bibliography: numeric in citation order with "[n] ", otherwise alphabetical.
function bibEntries(store, order) {
  if (store.numeric) return order.map((id, i) => `[${i + 1}] ${store.items[id].bib}`);
  return order.map((id) => store.items[id].bib).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}
// Numbers by first appearance of the located marks; items only in marks that could not be located keep their
// relative order after them.
function numberOrder(store, located) {
  const order = [];
  for (const m of located.filter((x) => x.pos != null).sort((a, b) => a.pos - b.pos)) for (const id of m.ids) if (!order.includes(id)) order.push(id);
  for (const id of store.order) if (!order.includes(id)) order.push(id);
  return order;
}

// ---- The References section ------------------------------------------------------------------------------------
const isBibTitle = (t) => BIB_HEADINGS.includes(String(t).trim().replace(/[:.]$/, '').trim().toLowerCase());
// The last heading titled like a bibliography and its body: the plain lines after it up to the next heading, table or
// the end (empty lines at the edges left out). { heading, first, last (line numbers; last < first: empty body),
// range: [offset start, offset end) of the whole section } or null.
function findBibSection(model) {
  let h = null;
  for (const l of model.lines) if (l.heading && !l.cell && isBibTitle(l.text)) h = l;
  if (!h) return null;
  let last = h.line;
  for (let n = h.line + 1; n <= model.lines.length; n++) {
    if (isClosing(model, n - 2)) break;
    const l = model.lines[n - 1];
    if (l.heading || l.cell) break;
    last = n;
  }
  let first = h.line + 1;
  while (first <= last && !model.lines[first - 1].text.trim()) first++;
  while (last >= first && !model.lines[last - 1].text.trim()) last--;
  const endLine = model.lines[Math.max(last, h.line) - 1];
  return { heading: h, first, last, range: [h.off, endLine.off + endLine.text.length] };
}
// The top heading level used in the document (HEADING_1 when none).
function topHeadingStyle(model) {
  let best = 0;
  for (const l of model.lines) { const m = /^HEADING_([1-6])$/.exec(l.style || ''); if (m && (!best || Number(m[1]) < best)) best = Number(m[1]); }
  return `HEADING_${best || 1}`;
}

// The part that makes the bibliography read entries: { s, oldText, newText, after?, restoreStyle?, removed } or
// { error }; null when it reads them already.
function bibPart(model, sec, entries) {
  const text = entries.join('\n');
  if (sec && sec.last >= sec.first) {
    const a = model.lines[sec.first - 1];
    const b = model.lines[sec.last - 1];
    const old = model.text.slice(a.off, b.off + b.text.length);
    if (old === text) return null;
    const { p, q } = commonEdges(old, text);
    return { s: a.off + p, oldText: old.slice(p, old.length - q), newText: text.slice(p, text.length - q), bib: true };
  }
  if (!text) return null;
  // A heading without entries: the entries go in after it as normal text.
  if (sec) {
    const h = sec.heading;
    return { s: h.off + h.text.length, oldText: '', newText: '\n' + text, restoreStyle: h.style, bib: true,
      after: (m, I) => [reqStyle(m, I + 1, I + 1 + text.length, 'NORMAL_TEXT')] };
  }
  // No section: a heading and the entries after the last line.
  const L = model.lines[model.lines.length - 1];
  const style = topHeadingStyle(model);
  return { s: L.off + L.text.length, oldText: '', newText: `\n${BIB_TITLE}\n${text}`, restoreStyle: L.style, bib: true,
    after: (m, I) => [
      ...(L.list ? [reqBulletsOff(m, I + 1, I + 1 + BIB_TITLE.length + 1 + text.length)] : []),
      reqStyle(m, I + 1, I + 1 + BIB_TITLE.length, style),
      reqStyle(m, I + 2 + BIB_TITLE.length, I + 2 + BIB_TITLE.length + text.length, 'NORMAL_TEXT')] };
}

// Where each stored mark is now (text offset of its label, or null): its context + label occurring once outside
// the bibliography, else the label alone occurring once there.
function locateMarks(model, store, sec) {
  const outside = (h, len) => !sec || h.at + len <= sec.range[0] || h.at >= sec.range[1];
  const taken = [];
  return store.marks.map((m) => {
    let pos = null;
    const hits = findFlexible(model.text, m.before + m.label, { normalize: false }).filter((h) => outside(h, h.text.length));
    if (hits.length === 1) pos = hits[0].at + m.before.length;
    else {
      const alone = findFlexible(model.text, m.label, { normalize: false }).filter((h) => outside(h, h.text.length) && !taken.includes(h.at));
      if (alone.length === 1) pos = alone[0].at;
    }
    if (pos != null) {
      if (taken.includes(pos)) pos = null;
      else taken.push(pos);
    }
    return { ...m, pos };
  });
}

// ---- Guards for the other write tools ----------------------------------------------------------------------------
// The labels of the stored in-text citations that an edit of model removes text from: ranges are [start, end) text
// offsets (plan.removed, docs-write.js); a citation counts when a range overlaps its label. In document order; []
// when nothing is cited or no citation is found (no network, so no grant needed). Read by runWriteTool, so the gate asks.
async function citationsInRanges(model, ranges) {
  if (!model || !model.docId || !ranges || !ranges.length) return [];
  const store = await loadCiteStore(model.docId);
  if (!store.marks.length) return [];
  const located = locateMarks(model, store, findBibSection(model)).filter((m) => m.pos != null);
  const hit = located.filter((m) => ranges.some(([s, e]) => e > s && s < m.pos + m.label.length && e > m.pos));
  return hit.sort((a, b) => a.pos - b.pos).map((m) => m.label);
}

// After a turn that edited the document: whether the stored citations still read in the text and the References
// section matches them, on the document as the turn left it (no network). Returns the problem sentences ([] when
// all is well).
function citationProblems(model, store) {
  const out = [];
  const sec = findBibSection(model);
  const located = locateMarks(model, store, sec);
  const lost = located.filter((m) => m.pos == null).map((m) => m.label);
  if (lost.length) out.push(lost.length === 1 ? `Citation ${lost[0]} is no longer in the text.` : `Citations ${lost.slice(0, 5).join(', ')} are no longer in the text.`);
  if (store.order.length && !sec) out.push('The References section is missing.');
  else if (sec) {
    const listed = model.lines.slice(sec.first - 1, Math.max(sec.first - 1, sec.last)).map((l) => l.text).filter((t) => t.trim());
    if (JSON.stringify(listed) !== JSON.stringify(bibEntries(store, store.order))) out.push('The References list does not match the citations.');
  }
  if (store.numeric && !lost.length && JSON.stringify(numberOrder(store, located)) !== JSON.stringify(store.order)) out.push('The citation numbers are out of order.');
  return out;
}
const REFRESH_HINT = 'cite with action "refresh" rebuilds the References list.';
// docId -> the problems found after the last editing turn, for the next turn's note (cleared after that turn).
const citeProblems = new Map();
// The 'finish' turn hook: a turn with a successful edit is checked; a sticky notice tells the user, the next turn's
// context note tells the model. The notice waits until the turn's final re-render (which clears the chat) is done.
async function checkCitationsAfterTurn(userMsg, snap, chatCtx) {
  const model = snap && snap.model;
  if (!model || !model.docId || snap.side) return;
  const msgs = (chatCtx && chatCtx.messages) || [];
  const edited = msgs.slice(msgs.indexOf(userMsg) + 1).some((m) => m.role === 'tool' && m._ok && m._edit);
  if (!edited) { citeProblems.delete(model.docId); return; }
  const store = await loadCiteStore(model.docId);
  if (!store.order.length && !store.marks.length) { citeProblems.delete(model.docId); return; }
  const problems = citationProblems(model, store);
  if (!problems.length) { citeProblems.delete(model.docId); return; }
  const text = `${problems.join(' ')} ${REFRESH_HINT}`;
  citeProblems.set(model.docId, text);
  whenIdle(() => { if (state.docId === model.docId) addNotice(text, { sticky: true }); });
}
// Runs fn once the panel is no longer busy with a turn (polls; gives up after about a minute).
function whenIdle(fn, tries = 1200) {
  if (!state.busy) { fn(); return; }
  if (tries > 0) setTimeout(() => whenIdle(fn, tries - 1), 50);
}

// ---- Applying the parts in one batch ---------------------------------------------------------------------------
// parts: [{ s (text offset), oldText, newText, after?(model, I) -> requests, restoreStyle? }], not overlapping.
// The requests go back to front, so every part's indices stay valid. Returns { requests } or { error }; sets
// part.I (the API index of its start before the edit).
function partsRequests(model, parts) {
  const requests = [];
  for (const p of parts.slice().sort((a, b) => b.s - a.s)) {
    if (p.oldText) {
      const r = indexRange(model, p.s, p.s + p.oldText.length);
      if (r.error) return { error: r.error, part: p };
      p.I = r.start;
      requests.push(reqDelete(model, r.start, r.end));
    } else {
      const l = lineAtOffset(model, p.s);
      if (!l.exact || l.suggested) return { error: `line ${l.line} contains suggested changes or cannot be mapped exactly; accept or reject the suggestions in Google Docs first`, part: p };
      p.I = indexAtOffset(model, p.s);
    }
    if (p.newText) requests.push(reqInsert(model, p.I, p.newText));
    if (p.after) requests.push(...p.after(model, p.I));
  }
  return { requests };
}
const delta = (p) => p.newText.length - p.oldText.length;
// Text offset after the edit of offset off before it (parts starting before off shift it).
const shifted = (parts, off) => off + parts.filter((p) => p.s < off).reduce((n, p) => n + delta(p), 0);
// The journal parts in the document after the edit, front to back: { index, text, restore, style? }.
function journalParts(parts) {
  return parts.slice().sort((a, b) => a.s - b.s).map((p) => ({
    index: p.I + parts.filter((x) => x.s < p.s).reduce((n, x) => n + delta(x), 0),
    text: p.newText, restore: p.oldText, ...(p.restoreStyle ? { style: p.restoreStyle } : {}),
  }));
}
// The lines a journal part covers in model.
function partLines(model, jp, out) {
  if (jp.text.startsWith('\n')) jp = { index: jp.index + 1, text: jp.text.slice(1) }; // new paragraphs: not the line before
  const a = lineAtIndex(model, jp.index) || lineAtIndex(model, jp.index - 1);
  const b = lineAtIndex(model, jp.index + Math.max(jp.text.length - 1, 0)) || a;
  if (!a) return;
  for (let n = a.line; n <= Math.max(a.line, b.line); n++) if (!out.includes(n)) out.push(n);
}

// Plans, gates, commits and journals a cite edit. what: { parts, store (the store after the edit, marks with pos =
// text offset of the label before the edit), prev (the store before), title, done(model, sec) -> sentence, cardText,
// notes, gateWhat }. Returns the tool fields.
async function commitCite(snap, call, ui, what) {
  const model = snap.model;
  const built = partsRequests(model, what.parts);
  if (built.error) {
    const where = built.part && built.part.bib ? 'the References section' : 'a citation';
    return writeError(`${where} cannot be changed: ${built.error}.`, 'cite: ' + built.error);
  }
  const removed = what.parts.map((p) => p.oldText).join('\n');
  const first = lineAtOffset(model, Math.min(...what.parts.map((p) => p.s))).line;
  const last = lineAtOffset(model, Math.max(...what.parts.map((p) => p.s + p.oldText.length))).line;
  const jparts = journalParts(what.parts);
  const plan = {
    requests: built.requests, region: [first, last], removedChars: removed.length, removedText: removed, gateWhat: what.gateWhat,
    journal: { kind: 'cite', parts: jparts, anchor: false, prevStore: what.prev, afterRev: what.store.rev },
    title: what.title, cardText: what.cardText, cardLabel: what.cardText ? 'Citation' : '', notes: what.notes || [],
    affected: () => [first, last],
  };
  const refused = await gateEdit('cite', plan, snap, ui);
  if (refused) return refused;
  const res = await commitSequence(snap, plan, call.id, [() => ({ requests: built.requests })]);
  if (res.fail) return res.fail;
  const now = res.model;
  for (const jp of jparts) jp.anchor = makeAnchor(now, jp.index, jp.text);
  // The marks' context as the document reads now.
  for (const m of what.store.marks) {
    if (m.pos == null) continue;
    const at = shifted(what.parts, m.pos) + (m.lead || 0);
    if (now.text.startsWith(m.label, at)) m.before = now.text.slice(Math.max(0, at - MARK_CONTEXT), at);
  }
  what.store.marks = what.store.marks.map(({ pos, lead, ...m }) => m);
  await saveCiteStore(now.docId, what.store);
  const lines = [];
  for (const jp of jparts) partLines(now, jp, lines);
  lines.sort((a, b) => a - b);
  plan.affected = () => [lines[0] || 1, lines[lines.length - 1] || 1];
  plan.report = (m) => changedLinesReport(m, lines);
  plan.done = what.done(now, findBibSection(now));
  return finishEdit(snap, plan, call.id, now);
}

// "References (lines 80–86) lists 7 works".
function bibWhere(sec, n) {
  const works = `${n} work${n === 1 ? '' : 's'}`;
  return sec ? `${sec.heading.text.trim()} (${rangeLabel(sec.heading.line, Math.max(sec.heading.line, sec.last))}) lists ${works}` : `the bibliography lists ${works}`;
}
const unlocatedNote = (marks) => {
  const lost = marks.filter((m) => m.pos == null);
  if (!lost.length) return [];
  return [`Note: ${lost.length} earlier citation${lost.length === 1 ? '' : 's'} (${lost.slice(0, 5).map((m) => `«${m.label}»`).join(', ')}) could not be found in the text (edited by hand?) and ${lost.length === 1 ? 'keeps its' : 'keep their'} label.`];
};

// Relabel parts of the located marks whose label changes; sets each mark's new label.
function relabelParts(store, located, order) {
  const parts = [];
  for (const m of located) {
    const label = markLabel(store, m.ids, order);
    if (m.pos != null && label !== m.label) parts.push({ s: m.pos, oldText: m.label, newText: label });
    if (m.pos != null) m.label = label;
  }
  return parts;
}

// ---- cite --------------------------------------------------------------------------------------------------------
async function citeInsert(args, snap, ui, call) {
  const model = snap.model;
  const ids = Array.isArray(args.ids) ? args.ids : typeof args.ids === 'string' ? [args.ids] : [];
  if (!ids.length) return writeError('insert needs ids: the ids that find_reference returned (zotero:KEY or doi:10.…).', 'cite: no ids');
  if (ids.length > CITE_MAX_IDS) return writeError(`at most ${CITE_MAX_IDS} ids per citation.`, 'cite: too many ids');
  const parsed = [];
  for (const raw of ids) {
    const p = parseCiteId(raw);
    if (!p) return writeError(`"${raw}" is not an id from find_reference (zotero:KEY or doi:10.…); call find_reference first.`, 'cite: invalid id');
    if (!parsed.some((x) => x.id === p.id)) parsed.push(p);
  }
  const after = typeof args.after_text === 'string' ? args.after_text.replace(/\r\n?/g, '\n') : '';
  if (!after.trim()) return writeError('insert needs after_text: the exact text the citation follows, occurring once in the document.', 'cite: no after_text');
  const hits = findFlexible(model.text, after);
  if (!hits.length) return writeError(notFoundError(model, after, 'after_text must be exact document text; read it with read_lines or find_in_document and try again').replace(/old_text/g, 'after_text'), 'cite: after_text not found');
  if (hits.length > 1) {
    const where = hitLines(model, hits).slice(0, 10).join(', ');
    return writeError(`after_text occurs ${hits.length} times (lines ${where}); give more of the text so that it occurs once.`, `cite: after_text occurs ${hits.length} times`);
  }
  const at = hits[0].at + hits[0].text.length;
  const sec = findBibSection(model);
  if (sec && at > sec.range[0] && at <= sec.range[1]) return writeError(`after_text is in the ${sec.heading.text.trim()} section; cite in the text instead.`, 'cite: after_text is in the bibliography');

  const prev = await loadCiteStore(model.docId);
  const store = clone(prev);
  const fresh = parsed.filter((p) => !store.items[p.id]);
  if (fresh.length) {
    let got;
    try { got = await formatItems(fresh, store.style, store.locale); } catch (e) { return writeError(e.message + '.', 'cite: ' + e.message); }
    Object.assign(store.items, got.items);
    if (got.numbered) store.numeric = true;
  }
  const located = locateMarks(model, store, sec);
  if (located.some((m) => m.pos != null && at > m.pos && at < m.pos + m.label.length)) return writeError('after_text ends inside an existing citation; give text that ends before or after it.', 'cite: after_text ends inside a citation');
  const newIds = parsed.map((p) => p.id);
  for (const id of newIds) if (!store.order.includes(id)) store.order.push(id);
  const lead = /\s$/.test(model.text.slice(Math.max(0, at - 1), at)) || at === 0 ? '' : ' ';
  const mark = { ids: newIds, label: '', before: '', pos: at, lead: lead.length };
  // The new mark counts for the numbering at its position; its label is written by the insert part.
  const order = store.numeric ? numberOrder(store, [...located, { ids: newIds, pos: at }]) : store.order;
  const relabels = relabelParts(store, located, order);
  mark.label = markLabel(store, newIds, order);
  store.order = order;
  store.marks = [...located, mark];
  store.rev = prev.rev + 1;
  const parts = [{ s: at, oldText: '', newText: lead + mark.label }, ...relabels];
  const bp = bibPart(model, sec, bibEntries(store, order));
  if (bp) parts.push(bp);
  const n = order.length;
  const where = lineAtOffset(model, at).line;
  return commitCite(snap, call, ui, {
    parts, store, prev, cardText: lead + mark.label,
    title: `Cited ${newIds.map((id) => store.items[id].short).join('; ')} on line ${where}`,
    gateWhat: 'inserts a citation and rewrites the References section',
    notes: unlocatedNote(located),
    done: (now, nsec) => `inserted «${showText(lead + mark.label)}» after «${oneLine(hits[0].text.slice(-40), 40)}» on line ${lineAtOffset(now, shifted(parts, at)).line}; ${bibWhere(nsec, n)}` +
      (relabels.length ? `; renumbered ${relabels.length} citation${relabels.length === 1 ? '' : 's'}` : ''),
  });
}

// refresh: the bibliography and the labels again from the stored items (no network). style: the items formatted
// in the new style first.
async function citeRebuild(args, snap, ui, call, newStyle) {
  const model = snap.model;
  const prev = await loadCiteStore(model.docId);
  const store = clone(prev);
  if (newStyle) {
    const style = String(newStyle).trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(style)) return writeError('style must be a CSL style id such as apa, chicago-author-date, ieee, vancouver or nature.', 'cite: invalid style');
    store.style = style;
    store.numeric = NUMERIC_STYLES.has(style);
    const parsed = store.order.map(parseCiteId).filter(Boolean);
    if (parsed.length) {
      let got;
      try { got = await formatItems(parsed, style, store.locale); } catch (e) { return writeError(e.message + '.', 'cite: ' + e.message); }
      for (const [id, it] of Object.entries(got.items)) store.items[id] = it;
      if (got.numbered) store.numeric = true;
    }
    if (!store.order.length) {
      store.rev = prev.rev + 1;
      await saveCiteStore(model.docId, store);
      return { content: `Done: the citation style of this document is now ${style}${store.numeric ? ' (numeric)' : ''}; no works are cited yet.`, _ok: true, _message: `Citation style: ${style}` };
    }
  }
  if (!store.order.length) return writeError('no works are cited in this document yet; use action "insert" first.', 'cite: nothing cited yet');
  const sec = findBibSection(model);
  const located = locateMarks(model, store, sec);
  const order = store.numeric ? numberOrder(store, located) : store.order;
  const relabels = relabelParts(store, located, order);
  store.order = order;
  store.marks = located;
  store.rev = prev.rev + 1;
  const parts = [...relabels];
  const bp = bibPart(model, sec, bibEntries(store, order));
  if (bp) parts.push(bp);
  const n = order.length;
  if (!parts.length) {
    if (newStyle) await saveCiteStore(model.docId, store);
    return { content: `Done: nothing to change; ${bibWhere(sec, n)} and the citations are up to date.${unlocatedNote(located).map((x) => '\n' + x).join('')}`, _ok: true, _message: 'References up to date' };
  }
  return commitCite(snap, call, ui, {
    parts, store, prev, cardText: '',
    title: newStyle ? `Citation style set to ${store.style}` : `References refreshed (${n})`,
    gateWhat: 'rewrites the References section',
    notes: unlocatedNote(located),
    done: (now, nsec) => `${newStyle ? `set the citation style to ${store.style}${store.numeric ? ' (numeric)' : ''}` : 'refreshed the bibliography'}; ${bibWhere(nsec, n)}` +
      (relabels.length ? `; relabeled ${relabels.length} citation${relabels.length === 1 ? '' : 's'}` : ''),
  });
}

async function runCite(name, args, snap, ui, call) {
  if (!snap.model) return writeError('cite needs the Google Docs API (sign in with Google in the settings).', 'cite: no Docs API');
  const action = String(args.action || '').trim().toLowerCase();
  if (action === 'insert') return citeInsert(args, snap, ui, call);
  if (action === 'refresh') return citeRebuild(args, snap, ui, call, null);
  if (action === 'style' || action === 'set_style') {
    if (typeof args.style !== 'string' || !args.style.trim()) return writeError('action "style" needs style: a CSL style id such as apa, ieee or vancouver.', 'cite: no style');
    return citeRebuild(args, snap, ui, call, args.style);
  }
  return writeError('action must be "insert", "refresh" or "style".', 'cite: invalid action');
}

// ---- find_reference -----------------------------------------------------------------------------------------------
async function runFindReference(name, args) {
  const q = typeof args.query === 'string' ? args.query.trim() : '';
  if (!q) return 'Error: query is empty. Give an author, title words, a year or a DOI.';
  const doi = parseDoi(q);
  const st = await zoteroStatus();
  let note = '';
  if (st.ok) {
    let items;
    try { items = await zoteroSearch(doi || q, !!doi); } catch (e) { return `Error: ${e.message}.`; }
    if (items.length) {
      return `${items.length} Zotero item${items.length === 1 ? '' : 's'} for "${oneLine(q, 60)}":\n` +
        items.map((it) => `zotero:${it.key}: ${itemSummary(it.data)}`).join('\n');
    }
    if (!doi) return `No Zotero items match "${oneLine(q, 60)}". Try an author's last name, a title word or a year, or give a DOI.`;
    note = 'Not in Zotero; ';
  } else if (!doi) {
    return `Error: ${zoteroProblem(st)}, or give a DOI.`;
  } else {
    note = st.reason === 'absent' ? 'Zotero is not running; ' : '';
  }
  let meta;
  try { meta = await crossrefMeta(doi); } catch (e) { return `Error: ${e.message}.`; }
  return `${note}DOI ${doi} (Crossref):\ndoi:${doi}: ${cslSummary(meta)}`;
}

// ---- Picks in the composer ("@smi") ----------------------------------------------------------------------------------
// The popup's items for a query: up to ZOTERO_PICK_MAX library items { key, who, year, title }, [] without the grant
// or when Zotero does not answer (the popup then stays closed; find_reference explains the setup).
const ZOTERO_PICK_MAX = 8;
async function zoteroPickItems(q) {
  if (!referencesOn() || String(q || '').trim().length < 2) return [];
  const st = await zoteroStatus();
  if (!st.ok) return [];
  let items;
  try { items = await zoteroSearch(String(q).trim()); } catch (e) { referencesRecheck(); return []; }
  return items.slice(0, ZOTERO_PICK_MAX).map((it) => ({ key: String(it.key || '').toUpperCase(), who: whoText(zoteroFamilies(it.data)),
    year: zoteroYear(it.data), title: String(it.data.title || 'Untitled').replace(/\s+/g, ' ').trim() }))
    .filter((it) => /^[A-Z0-9]{8}$/.test(it.key));
}
// Whether "@query" may search Zotero (slash.js asks while the user types). Without the grant the access card is shown
// once per panel load (not while a turn runs); Allow calls again() (the popup looks again), Not now leaves "@" inert
// until the panel is loaded again. A card left waiting is closed when a turn starts or the panel loads a document.
const zoteroAtAsk = { asked: false, abort: null };
function zoteroAtReady(again) {
  if (referencesOn()) return true;
  if (zoteroAtAsk.asked || state.busy) return false;
  zoteroAtAsk.asked = true;
  const abort = new AbortController();
  zoteroAtAsk.abort = abort;
  const ui = {};
  requestReferencesAccess('To list works from your Zotero library as you type @.', { signal: abort.signal, ui }).then((ok) => {
    if (zoteroAtAsk.abort === abort) zoteroAtAsk.abort = null;
    if (ui.card) ui.card.remove();
    if (ok && typeof again === 'function') again();
  });
  return false;
}
function closeZoteroAtCard() { if (zoteroAtAsk.abort) zoteroAtAsk.abort.abort(); }
// The token a pick puts into the message: "@[Smith & Lee 2020: Title start…](zotero:ABCD1234)" (no brackets inside).
const ZOTERO_TOKEN_TITLE = 30;
function zoteroToken(item) {
  const cut = item.title.slice(0, ZOTERO_TOKEN_TITLE);
  const sp = cut.lastIndexOf(' ');
  const t = item.title.length > ZOTERO_TOKEN_TITLE ? (sp > ZOTERO_TOKEN_TITLE / 2 ? cut.slice(0, sp) : cut).trim() + '…' : item.title; // at a word end
  const label = `${item.who} ${item.year}: ${t}`.replace(/\[/g, '(').replace(/\]/g, ')');
  return `@[${label}](zotero:${item.key})`;
}
const ZOTERO_TOKEN_RE = /@\[([^\]\n]{1,200})\]\(zotero:([A-Za-z0-9]{8})\)/g;
// The turn-context line for the picks in a message, or '': "Zotero items the user mentioned (ids for cite):
// zotero:ABCD1234 = Smith (2020), Title start…". Pure: the label comes from the token itself.
function zoteroMentionsLine(text) {
  const seen = new Map();
  for (const m of String(text || '').matchAll(ZOTERO_TOKEN_RE)) {
    const key = m[2].toUpperCase();
    if (seen.has(key)) continue;
    const parts = /^(.+?) (\d{4}|n\.d\.): (.+)$/.exec(m[1].trim());
    seen.set(key, parts ? `${parts[1]} (${parts[2]}), ${parts[3]}` : m[1].trim());
  }
  if (!seen.size) return '';
  return 'Zotero items the user mentioned (ids for cite): ' + [...seen].map(([k, v]) => `zotero:${k} = ${v}`).join('; ');
}

// ---- Undo ----------------------------------------------------------------------------------------------------------
// Every part is checked on the current document before anything changes (its context anchor, or the anchor text found
// once elsewhere when text moved), then all are reverted in one batch, back to front. The store goes back to the one
// before the edit unless another cite wrote since.
async function undoCite(edit) {
  const ctrlZ = 'so it cannot be undone automatically. Use Undo (Ctrl+Z) in Google Docs instead.';
  const model = await fetchDocModel(edit.docId, edit.tabId);
  const parts = (edit.parts || []).map((p) => {
    if (anchorMatches(model, p)) return { ...p };
    const a = p.anchor;
    const hits = a ? findFlexible(model.text, a.before + p.text + a.after, { normalize: false }) : [];
    if (hits.length === 1) {
      const moved = { ...p, index: indexAtOffset(model, hits[0].at + a.before.length) };
      if (anchorMatches(model, moved)) return moved;
    }
    throw new Error(`the citation or the References section changed after that edit, ${ctrlZ}`);
  });
  if (!parts.length) throw new Error('there is nothing to undo for that edit.');
  const requests = [];
  for (const p of parts.slice().sort((x, y) => y.index - x.index)) {
    if (p.text) requests.push(reqDelete(model, p.index, p.index + p.text.length));
    if (p.restore) requests.push(reqInsert(model, p.index, p.restore));
    if (p.style) requests.push(reqStyle(model, p.index, p.index + 1, p.style));
  }
  await docsBatchUpdate(model, requests);
  const now = await fetchDocModel(edit.docId, edit.tabId);
  const cur = await loadCiteStore(edit.docId);
  let note;
  if (edit.prevStore && cur.rev === edit.afterRev) await saveCiteStore(edit.docId, sanitizeStore(edit.prevStore));
  else note = 'Note: the list of cited works changed after that edit and was kept; call cite with action "refresh" if the References section looks wrong.';
  const lines = [];
  const sorted = parts.slice().sort((x, y) => x.index - y.index);
  let d = 0;
  for (const p of sorted) {
    partLines(now, { index: p.index + d, text: p.restore }, lines);
    d += p.restore.length - p.text.length;
  }
  return { model: now, restored: '', lostObjects: false, lines: lines.sort((a, b) => a - b), what: `undid "${edit.title}"`, note };
}
registerUndoHandler('cite', undoCite);

// ---- Registration ---------------------------------------------------------------------------------------------------
const FIND_REFERENCE_DEF = {
  type: 'function',
  function: {
    name: 'find_reference',
    description: "Search the user's Zotero library (author, title words, year) or look up a DOI. Returns ids for cite.",
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Author, title words and/or year, or a DOI.' } },
      required: ['query'], additionalProperties: false,
    },
  },
};
const CITE_DEF = {
  type: 'function',
  function: {
    name: 'cite',
    description: 'insert: put an in-text citation of find_reference ids right after after_text and add the works to the References section (created at the end when missing). refresh: rebuild the References section and the numbering. style: change the citation style of the document. Plain text, not linked to Zotero\'s own Docs plugin.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['insert', 'refresh', 'style'] },
        ids: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }], description: 'insert: ids from find_reference (zotero:KEY or doi:10.…).' },
        after_text: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'insert: exact text, occurring once, that the citation follows (usually the words before a full stop).' },
        style: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'style: CSL style id, e.g. apa, chicago-author-date, ieee, vancouver, nature.' },
      },
      required: ['action', 'ids', 'after_text', 'style'], additionalProperties: false,
    },
  },
};

registerTools([FIND_REFERENCE_DEF], {
  offer: (mode, snap) => refsOffered(snap),
  reading: true, icon: '📚',
  summary: (name, args) => `"${oneLine(String(args.query || ''), 60)}"`,
  run: (name, args, snap, ui) => withReferences(snap, ui, 'To find works to cite.', () => runFindReference(name, args)),
  prompt: [{ section: 'reading', line: "- find_reference(query): look up works to cite in the user's Zotero library or by DOI; returns ids for cite." }],
  docNote: (snap) => {
    const s = snap.docId ? citeCache.get(snap.docId) : null;
    const problem = snap.docId ? citeProblems.get(snap.docId) : '';
    return s && s.order.length ? `References: ${s.order.length} cited item${s.order.length === 1 ? '' : 's'}, style ${s.style}${problem ? `. After the last edit: ${problem}` : ''}` : '';
  },
});
registerTools([CITE_DEF], {
  offer: (mode, snap) => refsOffered(snap) && apiEditing(mode, snap),
  reading: false, icon: '📚', pending: 'Citing…',
  summary: (name, args) => (args.action === 'insert' ? `insert ${(Array.isArray(args.ids) ? args.ids : []).join(', ')}${typeof args.after_text === 'string' ? ` after "${oneLine(args.after_text, 40)}"` : ''}`
    : args.action === 'style' ? `style ${args.style}` : String(args.action || '')),
  gate: (name, plan) => ({ large: (plan.removedChars || 0) >= GATE_REPLACE_CHARS, what: plan.gateWhat || 'changes citations', range: '',
    excerptLabel: plan.removedText ? 'Removed text' : '', excerpt: oneLine(plan.removedText || '', 300) }),
  run: (name, args, snap, ui, call) => withReferences(snap, ui, 'To write the citation and the References list.', () => runCite(name, args, snap, ui, call)),
  prompt: [{ section: 'edit', line: '- cite(action, ids, after_text, style): "insert" puts an in-text citation of find_reference ids after after_text and keeps the References section in sync; "refresh" rebuilds it and the numbering; "style" changes the citation style. Never type citations or reference lists by hand.' }],
});
// The turn context's note needs the store of the document the panel shows.
registerTurnHook('panelDoc', (docId) => { closeZoteroAtCard(); return docId ? loadCiteStore(docId) : null; });
// The offer of the reference tools, fixed for the turn (refsOffered); a waiting "@" card is closed.
registerTurnHook('beforeTurn', (mode, snap) => {
  closeZoteroAtCard();
  if (snap) snap.refsOffer = referencesOn() || refsMentioned(lastSentText()) || refsMentioned(snap.docInstructions);
  return '';
});
registerTurnHook('finish', checkCitationsAfterTurn);
// The Zotero picks in the message this turn sends (render.js keeps its text): one context line for the model.
registerTurnHook('beforeTurn', () => (referencesOn() ? zoteroMentionsLine(lastSentText()) : ''));
