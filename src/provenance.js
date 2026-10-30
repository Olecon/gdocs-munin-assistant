'use strict';
// Module provenance.js: where the numbers and references of new text come from (no model call).
// - beforeWrite: a write that brings a number, DOI or citation marker found nowhere in the document, the user's
//   message of this turn, this turn's tool results (find_reference, cite, web search, reads) or the document
//   instructions is refused once; the identical retry passes (the model was told to use the item only if the user
//   gave it, else to write the placeholder [[?]]). Years, small integers and the numbers of places (line, section,
//   figure, table, page; heading numbers) are not checked.
// - Number ripple: a replace that changes a number (48 → 52, same unit) records the pair; at 'finish' the final text
//   is searched for the old value and a notice says which lines still have it.
// - At 'finish': the [[?]] placeholders left in the document after an editing turn (sticky notice), and an answer that
//   claims a check ("verified", "checked against Crossref", "проверил по", "сверил с") no tool call of the turn made.
// claimItems (prose-lint.js) finds the numbers and citations.
/* global addNotice, apiEditing, claimItems, CMP_NORM, NUM_CMP, NUM_STAT, numberValue, registerPromptLine, registerTurnHook, state */
/* exported PROV_TOOLS, PROV_PLACEHOLDER, PROV_PROMPT_LINE, provItems, provenanceCheck, rippleNumbers, ripplePairs, rippleNotice,
   placeholderCount, claimedCheck, provFinish */

const PROV_TOOLS = ['replace_text', 'replace_all', 'replace_section', 'insert_after_line', 'replace_selection'];
const PROV_PLACEHOLDER = '[[?]]';
const PROV_SMALL_INT = 12; // integers up to this are counts and list numbers, not claims
const PROV_NEAR = 300; // characters between a surname and its year in a source (a reference entry, a search result)
const PROV_MAX_LIST = 8; // items named in a refusal
const RIPPLE_MAX_LINES = 5; // lines named per changed number
const PROV_PROMPT_LINE = '- A number, DOI or reference you cannot find in the document, the user\'s message or a tool result is unknown: write [[?]] in its place and tell the user what is missing.';

// Numbers that name a place, not a claim: "line 12", "Fig. 3", "Table 2", "Eq. (4)", "section 2.1", "p. 45",
// "рис. 3", "табл. 2", "раздел 2.1", "с. 45", and heading or item numbers at the start of a line ("2.1 Methods").
const PROV_POINTER_RE = /(?<![\p{L}\p{N}])(?:lines?|sections?|sect\.|chapters?|ch\.|figures?|figs?\.|tables?|tab\.|eqs?\.|equations?|steps?|parts?|appendix|pages?|pp?\.|items?|no\.|nos\.|§|рис\.|рисун\p{L}*|табл\.|таблиц\p{L}*|раздел\p{L}*|разд\.|глав\p{L}*|гл\.|строк\p{L}*|ур\.|уравнени\p{L}*|стр\.|с\.|шаг\p{L}*|пункт\p{L}*|п\.)\s*\(?\d+(?:[.,]\d+)*(?:\s*[-–—]\s*\d+(?:[.,]\d+)*)?[a-zа-я]?\)?/giu;
const PROV_HEADNUM_RE = /^(\s*)\d+(?:\.\d+)*\.?(?=\s)/gmu;
const provBlank = (m) => m.replace(/[^\n]/g, ' ');
const provUnpointed = (text) => String(text || '').replace(PROV_POINTER_RE, provBlank).replace(PROV_HEADNUM_RE, (m, sp) => sp + provBlank(m.slice(sp.length)));

// A number's value as one key: "0,50", "0.5" and "0.5 %" are all "0.5" (percent and unit are not compared: a
// value the sources have in another form is still known). A statistic's comparator other than "=" is kept
// ("p < 0.01" is "<0.01"): such an item is known only with the same comparator; a plain one by its value.
function provValue(key) {
  const v = String(key).replace(/%$/, '');
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : v;
}
const isYear = (text) => /^\d{4}$/.test(text) && Number(text) >= 1800 && Number(text) <= 2100;
const isSmallInt = (value) => /^-?\d+$/.test(value) && Math.abs(Number(value)) <= PROV_SMALL_INT;

// The checked items of a new text: [{ kind: 'number' | 'doi' | 'bracket' | 'author', key, text, name?, year? }].
function provItems(text) {
  const { numbers, citations } = claimItems(provUnpointed(text));
  const out = [];
  for (const n of numbers) {
    const value = provValue(n.value);
    if (isYear(n.text.trim()) || isSmallInt(value)) continue;
    out.push({ kind: 'number', key: n.cmp + value, text: n.text.trim() });
  }
  for (const c of citations) {
    if (/^10\./.test(c.key)) out.push({ kind: 'doi', key: c.key, text: c.text });
    else if (/^\[\d+\]$/.test(c.key)) out.push({ kind: 'bracket', key: c.key, text: c.text });
    else {
      const m = /^(.+) (\d{4})[a-zа-я]?$/u.exec(c.key);
      if (m) out.push({ kind: 'author', key: c.key, text: c.text, name: m[1], year: m[2] });
    }
  }
  const seen = new Set();
  return out.filter((it) => { const k = it.kind + it.key; if (seen.has(k)) return false; seen.add(k); return true; });
}

// What a source text knows: { numbers: Set(value), cites: Set(key), lower }.
function provIndex(text) {
  const s = String(text || '');
  const { numbers, citations } = claimItems(s);
  return { numbers: new Set(numbers.flatMap((n) => [provValue(n.value), n.cmp + provValue(n.value)])), cites: new Set(citations.map((c) => c.key)), lower: s.toLowerCase() };
}
// The index of a text, kept on the snapshot while the text is the same string (the document is indexed once a turn,
// again only after an edit re-read it).
function provCached(snap, slot, text) {
  if (text == null || text === '') return null;
  const c = snap[slot];
  if (c && c.text === text) return c.index;
  const index = provIndex(text);
  snap[slot] = { text, index };
  return index;
}

const provStr = (v) => (typeof v === 'string' ? v : '');
// The messages of this turn: from its user message (the last one that is not an automatic continuation) on.
function provTurnMessages(snap) {
  const msgs = (snap && snap.chatCtx && snap.chatCtx.messages) || state.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user' && !msgs[i]._auto) return msgs.slice(i);
  return [];
}
// The text of this turn's results: tool results (not the refusals of the checks, which name the unknown items), and
// the answers that carried server-side web search (their raw blocks hold the cited passages).
function provResultsText(turn) {
  const out = [];
  for (const m of turn.slice(1)) {
    if (m.role === 'tool') { if (!provStr(m.content).startsWith('Refused by a check')) out.push(provStr(m.content)); }
    else if (m.role === 'assistant' && ((m._toolActivity && m._toolActivity.length) || (m._sources && m._sources.length))) {
      out.push(provStr(m.content), JSON.stringify(m._anthropicBlocks || m._openaiItems || []), JSON.stringify(m._sources || []));
    }
  }
  return out.join('\n');
}

// The sources of a write: the document (as the turn started, and as this turn's edits left it), the user's message,
// this turn's results and the document instructions.
function provSources(snap) {
  const turn = provTurnMessages(snap);
  const user = turn.length ? provStr(turn[0].content) : '';
  return [
    provCached(snap, 'provStart', snap.promptView ? snap.promptView.docText : null),
    provCached(snap, 'provNow', snap.docText),
    provIndex(user + '\n' + provResultsText(turn) + '\n' + provStr(snap.docInstructions)),
  ].filter(Boolean);
}

// A surname and the year within PROV_NEAR characters of it in a source ("Smith, J. (2020). Title…").
function nearYear(lower, name, year) {
  for (let i = lower.indexOf(name); i >= 0; i = lower.indexOf(name, i + 1)) {
    if (lower.slice(Math.max(0, i - PROV_NEAR), i + name.length + PROV_NEAR).includes(year)) return true;
  }
  return false;
}
function provKnown(it, sources) {
  return sources.some((s) => {
    if (it.kind === 'number') return s.numbers.has(it.key);
    if (it.kind === 'doi') return s.lower.includes(it.key);
    if (it.kind === 'bracket') return s.cites.has(it.key);
    return s.cites.has(it.key) || nearYear(s.lower, it.name, it.year);
  });
}

// The old and the new text of a write (old is '' for an insert; replace_all: one occurrence).
function provTexts(name, plan, args, snap) {
  if (name === 'insert_after_line') return { oldText: '', newText: provStr(args.text) };
  if (name === 'replace_selection') return { oldText: provStr(snap.selection) || provStr(plan && plan.journal && plan.journal.restore), newText: provStr(args.text) };
  if (name === 'replace_section') return { oldText: provStr(plan && plan.section && plan.section.removed), newText: provStr(args.new_text) };
  return { oldText: provStr(args.old_text), newText: provStr(args.new_text) };
}

// A short stable hash of a call (name and arguments), for the per-turn set of refused calls.
function provHash(name, args) {
  const s = name + '\u0000' + JSON.stringify(args || {});
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36) + ':' + s.length;
}

// beforeWrite(name, plan, args, snap) -> null | { refuse }. The first call with unknown items is refused; its hash goes
// into snap.provRefused (per turn), and the identical call again passes: the model was told to use the items only if
// the user gave them, and a second identical call is that decision. A write that passes records its changed numbers
// for the ripple notice.
function provenanceCheck(name, plan, args, snap) {
  if (!PROV_TOOLS.includes(name) || !snap) return null;
  const { oldText, newText } = provTexts(name, plan, args || {}, snap);
  if (!newText.trim()) return null;
  const items = provItems(newText);
  if (items.length) {
    const sources = provSources(snap);
    const unknown = items.filter((it) => !provKnown(it, sources)).map((it) => it.text);
    if (unknown.length) {
      const hash = provHash(name, args);
      if (!snap.provRefused) snap.provRefused = new Set();
      if (!snap.provRefused.has(hash)) {
        snap.provRefused.add(hash);
        const list = unknown.slice(0, PROV_MAX_LIST).join(', ') + (unknown.length > PROV_MAX_LIST ? ` and ${unknown.length - PROV_MAX_LIST} more` : '');
        return { refuse: `these are not in the document, your message or this turn's results: ${list}. Use them only if the user gave them (then call the tool again unchanged); otherwise write the placeholder ${PROV_PLACEHOLDER} in their place and say what is missing.` };
      }
    }
  }
  if (oldText.trim()) rippleRecord(name, oldText, newText, snap);
  return null;
}

// ---- Number ripple ---------------------------------------------------------------------------------------------
// Numbers with their unit: [{ value, unit, text, at }], without the numbers of places, citations, DOIs and years.
const RIPPLE_UNITS = '%|mg|µg|μg|ng|kg|g|ml|mL|µl|μl|l|L|nm|µm|μm|mm|cm|km|m|ms|min|s|h|K|°C|°F|°|Hz|kHz|MHz|mmol|mol|mM|µM|μM|M|kDa|Da|мг|кг|г|мл|л|нм|мкм|мм|см|км|м|мс|мин|с|ч|°С';
const RIPPLE_NUM_RE = new RegExp(`(?<![\\p{L}\\p{N}.,])(?:${NUM_STAT}\\s*(${NUM_CMP})\\s*)?([-−]?\\d+(?:[.,]\\d+)*(?![.,]?\\d))(?:\\s?(${RIPPLE_UNITS})(?![\\p{L}\\p{N}]))?`, 'gu');
const RIPPLE_CITE_RE = /\b10\.\d{4,9}\/[^\s,;)\]]+|\[\d+(?:\s*[,–-]\s*\d+)*\]|\([^()]*\p{Lu}[^()]*\d{4}[a-zа-я]?\)|\(\d{4}[a-zа-я]?\)/gu;
function rippleNumbers(text) {
  const s = provUnpointed(text).replace(RIPPLE_CITE_RE, provBlank);
  const out = [];
  for (const m of s.matchAll(RIPPLE_NUM_RE)) {
    const raw = m[2].replace(/−/g, '-');
    const value = numberValue(raw);
    if (!Number.isFinite(Number(value)) || (!m[3] && !m[1] && isYear(raw)) || isSmallInt(value)) continue;
    // A statistic's comparator is part of the value ("p < 0.01" → "p = 0.01" is a change).
    const cmp = m[1] ? (m[1] in CMP_NORM ? CMP_NORM[m[1]] : m[1]) : '';
    const from = cmp ? 0 : m[0].lastIndexOf(m[2]);
    out.push({ value: cmp + value, unit: m[3] || '', text: m[0].slice(from), at: m.index + from });
  }
  return out;
}
// The numbers a replace changed: [{ old, unit, to, oldText }]. A number of the old text that the new text does not
// have (same value and unit) is paired, in order, with a new number of the same unit that the old text did not have.
function ripplePairs(oldText, newText) {
  const a = rippleNumbers(oldText);
  const b = rippleNumbers(newText);
  const has = (list, x) => list.some((y) => y.value === x.value && y.unit === x.unit);
  const lost = a.filter((x) => !has(b, x));
  const gained = b.filter((x) => !has(a, x));
  const pairs = [];
  const used = new Set();
  for (const x of lost) {
    const j = gained.findIndex((y, k) => !used.has(k) && y.unit === x.unit);
    if (j < 0) continue;
    used.add(j);
    if (!pairs.some((p) => p.old === x.value && p.unit === x.unit)) pairs.push({ old: x.value, unit: x.unit, to: gained[j].value, oldText: x.text.trim() });
  }
  return pairs;
}
function rippleRecord(name, oldText, newText, snap) {
  const pairs = ripplePairs(oldText, newText);
  if (!pairs.length) return;
  if (!snap.ripple) snap.ripple = { pairs: [], writes: [] };
  for (const p of pairs) if (!snap.ripple.pairs.some((q) => q.old === p.old && q.unit === p.unit)) snap.ripple.pairs.push(p);
  snap.ripple.writes.push({ oldText, newText });
}

// The final text of a turn: the document as the last re-read after an edit left it (Docs API), else the snapshot
// with the pasted replacement applied.
function provFinalText(snap) {
  const text = snap.docText == null ? null : String(snap.docText);
  if (text == null || (snap.docFormat === 'docs-api' && snap.model)) return text;
  if (!snap.pasteDone || !snap.ripple) return text;
  let t = text;
  for (const w of snap.ripple.writes) if (w.oldText && t.includes(w.oldText)) t = t.replace(w.oldText, () => w.newText);
  return t;
}

// The heading each line falls under: from the Docs API model when it is the final text, else Markdown headings.
function provHeadings(snap, text) {
  const lines = text.split('\n');
  const heads = new Array(lines.length).fill('');
  let cur = '';
  const fromModel = snap.model && snap.model.text === text ? snap.model.lines : null;
  lines.forEach((l, i) => {
    const h = fromModel ? (fromModel[i] && fromModel[i].heading ? fromModel[i].text.trim() : '') : ((/^#{1,6}\s+(.+?)\s*#*\s*$/.exec(l) || [])[1] || '');
    if (h) cur = h.length > 40 ? h.slice(0, 40) + '…' : h;
    heads[i] = cur;
  });
  return heads;
}

// The notice of one changed number, or '' when the final text no longer has the old value (or lacks the new one: the
// write did not happen).
function rippleNotice(pair, text, heads) {
  const lines = text.split('\n');
  const same = (x, v) => x.value === v && x.unit === pair.unit;
  if (!lines.some((l) => rippleNumbers(l).some((x) => same(x, pair.to)))) return '';
  const hits = [];
  lines.forEach((l, i) => { if (rippleNumbers(l).some((x) => same(x, pair.old))) hits.push(i); });
  if (!hits.length) return '';
  const named = hits.slice(0, RIPPLE_MAX_LINES).map((i) => `line ${i + 1}${heads[i] ? ` (${heads[i]})` : ''}`);
  const more = hits.length - named.length;
  let list = named.length === 1 ? named[0] : `${named.slice(0, -1).join(', ')}${more ? ', ' : ' and '}${named[named.length - 1]}`;
  if (more) list += ` and ${more} more line${more === 1 ? '' : 's'}`;
  return `${list[0].toUpperCase()}${list.slice(1)} still ${hits.length === 1 ? 'says' : 'say'} ${pair.oldText}.`;
}

// ---- Finish: placeholders and claimed checks -------------------------------------------------------------------
function placeholderCount(text) {
  return String(text || '').split(PROV_PLACEHOLDER).length - 1;
}

// Claims of a check in an answer: a check against a reference source needs find_reference, cite or a web search; a
// plain "verified" / "checked" needs any tool call that reads or writes (a write's result re-reads its lines).
const CLAIM_SOURCE_RE = /(?:verified|checked|confirmed|cross-?checked|looked up)(?:\s+[\p{L}\p{N}.'-]+){0,4}?\s+(?:against|with|in|on|via|through|using)\s+(?:the\s+)?(?:crossref|zotero|pubmed|doi\.org|google scholar|scopus|web of science|the web|online sources)|(?:провер|свер)\p{L}*(?:\s+[\p{L}\p{N}.-]+){0,4}?\s+(?:по|с|в|через)\s+(?:crossref|zotero|pubmed|doi|google scholar|scopus|интернет|источник)/iu;
const CLAIM_ANY_RE = /(?<![\p{L}])(?:verified|double-checked|cross-checked|checked against|провер(?:ил|ила|или|ено|ены)\s+(?:по|в|с)(?![\p{L}])|свер(?:ил|ила|или|ено)\s+с(?![\p{L}]))/iu;
const NOT_A_CHECK = ['ask_user', 'remember', 'draft'];
const REFERENCE_CHECKS = ['find_reference', 'cite'];
// What the final answer of a turn claims and whether a tool call backs it: 'source' | 'any' | null (no unbacked claim).
function claimedCheck(turn) {
  let answer = '';
  const calls = [];
  let searched = false;
  for (const m of turn.slice(1)) {
    if (m.role !== 'assistant') continue;
    if (typeof m.content === 'string' && m.content.trim()) answer = m.content;
    for (const tc of m.tool_calls || []) if (tc && tc.function) calls.push(tc.function.name);
    if ((m._toolActivity && m._toolActivity.length) || (m._sources && m._sources.length)) searched = true;
  }
  if (!answer) return null;
  if (CLAIM_SOURCE_RE.test(answer) && !searched && !calls.some((n) => REFERENCE_CHECKS.includes(n))) return 'source';
  if (CLAIM_ANY_RE.test(answer) && !searched && !calls.some((n) => !NOT_A_CHECK.includes(n))) return 'any';
  return null;
}

// The notices of a finished turn: [text] (placeholders, changed numbers still elsewhere, an unbacked check claim).
function provFinish(userMsg, snap, chatCtx) {
  const out = [];
  const msgs = (chatCtx && chatCtx.messages) || [];
  const from = userMsg ? msgs.indexOf(userMsg) : -1;
  const turn = from >= 0 ? msgs.slice(from) : [];
  const edited = !!snap.pasteDone || turn.some((m) => m.role === 'tool' && m._ok && m._edit);
  const text = provFinalText(snap);
  if (text != null && edited) {
    const n = placeholderCount(text);
    if (n) out.push(`${n} placeholder${n === 1 ? '' : 's'} ${PROV_PLACEHOLDER} ${n === 1 ? 'remains' : 'remain'} in the document.`);
    if (snap.ripple && snap.ripple.pairs.length) {
      const heads = provHeadings(snap, text);
      for (const p of snap.ripple.pairs) { const t = rippleNotice(p, text, heads); if (t) out.push(t); }
    }
  }
  if (claimedCheck(turn)) out.push('The answer claims a check that no tool call made.');
  return out;
}

// Runs fn once the panel is no longer busy with a turn (the turn's final re-render drops notices).
function provWhenIdle(fn, tries = 1200) {
  if (!state.busy) { fn(); return; }
  if (tries > 0) setTimeout(() => provWhenIdle(fn, tries - 1), 50);
}

registerTurnHook('beforeWrite', provenanceCheck);
registerPromptLine({ section: 'edit', line: PROV_PROMPT_LINE, when: (mode, snap) => !!snap && apiEditing(mode, snap), names: 'provenance' });
registerTurnHook('finish', (userMsg, snap, chatCtx) => {
  if (!snap || !snap.docId) return;
  const notices = provFinish(userMsg, snap, chatCtx);
  if (!notices.length) return;
  const docId = snap.docId;
  provWhenIdle(() => { if (state.docId === docId) for (const t of notices) addNotice(t, { sticky: true }); });
});
