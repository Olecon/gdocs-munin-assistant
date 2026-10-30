'use strict';
// Module prose-lint.js: a deterministic check of the text a write puts into the document (no model call):
// proseTells (the tell lists of src/prose-lists.js: chat residue, staging, tails, run-ups, stock words, Russian
// fillers, hedges, wordiness, redundancy; and the dash rate), claimDrift (numbers, citations and qualifiers an
// edit loses), and proseCheck, registered as a beforeWrite hook (registry.js): lost numbers or
// citations refuse the write once, the rest become notes on the tool result. Pure functions, also loaded by
// development/tools/prose-score.js.
/* global countWords, docStyleStats, PROSE_TELL_ORDER, PROSE_TELLS, registerTurnHook, sentenceSpans, STYLE_SAMPLE_CHARS,
   textLang, Typograf */
/* exported PROSE_TOOLS, proseTells, claimItems, claimDrift, proseCheck, proseWords, proseDashes, typographyIssues,
   typographyNote, typoHabits, typographicDashes, numberValue, NUM_STAT, NUM_CMP, CMP_NORM */

// ---- The tells -------------------------------------------------------------------------------------------
// The lists live in src/prose-lists.js (PROSE_TELLS, PROSE_TELL_ORDER). Every entry becomes a whole-word regex
// (letters of any script: \p{L} with the u flag); an entry flagged 's' is tried only at the start of each sentence
// (sentenceSpans, src/text-segments.js; leading quotes and brackets skipped). A pattern that starts with a comma
// (the tails) follows a word, so only its end is bounded.
const TELL_RES = PROSE_TELL_ORDER.flatMap((kind) => PROSE_TELLS[kind].map(([src, hint, flags = '']) => {
  const start = flags.includes('s');
  const lead = start ? '^' : src.startsWith(',') ? '' : '(?<![\\p{L}\\p{N}])';
  return { kind, hint, start, re: new RegExp(`${lead}(?:${src})(?![\\p{L}\\p{N}])`, start ? 'iu' : 'giu') };
}));

// Dashes: counted as docStyleStats counts them (an em dash, or an en dash or hyphen between spaces); words as
// countWords counts them (src/text-segments.js: "3.5" and "well-known" are one word). A text is flagged when it
// has at least DASH_MIN_WORDS words, at least two dashes and more than DASH_RATE_FACTOR times the document's rate
// per 1,000 words.
const DASH_RE = /—|(?<=\s)[–-](?=\s)/g;
const DASH_MIN_WORDS = 30;
const DASH_RATE_FACTOR = 3;
const proseWords = (text) => countWords(text);
const proseDashes = (text) => (String(text || '').match(DASH_RE) || []).length;

const proseClip = (s, n = 50) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };

// The offsets where the sentences of a text begin, after opening quotes, brackets and list dashes.
function sentenceStarts(text) {
  return sentenceSpans(text).map((sp) => sp.start + (sp.text.match(/^[\s"'«“„([\-–—•*]*/u) || [''])[0].length);
}

// The tells of a text: [{ kind, match, hint }] in text order. docStats: docStyleStats of the document (the dash
// rate is compared with it; no dash check without it).
function proseTells(text, docStats) {
  const s = String(text || '');
  const hits = [];
  const taken = [];
  let starts = null; // the sentence starts, computed once when a start-only entry needs them
  const take = (kind, hint, at, text) => {
    const from = at + (text.length - text.trimStart().length);
    const to = at + text.length;
    if (!text || taken.some(([a, b]) => from < b && to > a)) return;
    taken.push([from, to]);
    hits.push({ kind, match: proseClip(s.slice(from, to).replace(/^,\s*/, ', ')), hint, at: from });
  };
  for (const { kind, hint, start, re } of TELL_RES) {
    if (start) {
      if (!starts) starts = sentenceStarts(s);
      for (const at of starts) { const m = s.slice(at).match(re); if (m) take(kind, hint, at, m[0]); }
      continue;
    }
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s))) {
      if (!m[0]) { re.lastIndex++; continue; }
      take(kind, hint, m.index, m[0]);
    }
  }
  hits.sort((a, b) => a.at - b.at);
  const out = hits.map(({ kind, match, hint }) => ({ kind, match, hint }));
  const words = proseWords(s);
  // Russian: ranges and direct-speech dashes are typography, not style (typographicDashes, Typograf).
  const dashes = Math.max(0, proseDashes(s) - (textLang(s) === 'ru' ? typographicDashes(s) : 0));
  if (docStats && words >= DASH_MIN_WORDS && dashes >= 2) {
    const rate = Math.round((dashes * 10000) / words) / 10;
    if (rate > DASH_RATE_FACTOR * (Number(docStats.dashesPer1000) || 0)) {
      out.push({ kind: 'dashes', match: `${rate} dashes per 1,000 words (the document: ${docStats.dashesPer1000})`, hint: 'commas, colons or periods' });
    }
  }
  return out;
}

// ---- Typography of Russian text (Typograf in check mode) ---------------------------------------------------
// vendor/typograf.min.js (MIT) is loaded before this module and only ever runs on a copy of the new text: the
// differences between its output and the input become one note. Rule groups (every other rule, the ё
// replacement and the HTML entities included, is off): «» quotes, dashes for spaced hyphens, no-break spaces
// (after short words, before units and years, in "см. рис. 3", in initials) and, for the dash rate, the
// typographic dashes (ranges of years, centuries, days and times, direct speech). Without the global (a test
// without the vendored file) the typography check is skipped.
const TYPO_RULES = {
  quotes: ['common/punctuation/quote'],
  dash: ['ru/dash/main'],
  nbsp: ['common/nbsp/afterShortWord', 'common/nbsp/afterNumber', 'ru/nbsp/see', 'ru/nbsp/page', 'ru/nbsp/abbr',
    'ru/nbsp/initials', 'ru/nbsp/year', 'ru/nbsp/years', 'ru/nbsp/m', 'ru/nbsp/centuries', 'ru/nbsp/dayMonth'],
  ranges: ['ru/dash/years', 'ru/dash/centuries', 'ru/dash/daysMonth', 'ru/dash/decade', 'ru/dash/time', 'ru/dash/month',
    'ru/dash/weekday', 'ru/dash/directSpeech'],
};
const TYPOGRAFS = new Map();
// Typograf's output for one rule group, or null (no Typograf, or it failed).
function typoRun(group, text) {
  if (typeof Typograf !== 'function') return null;
  try {
    if (!TYPOGRAFS.has(group)) TYPOGRAFS.set(group, new Typograf({ locale: ['ru', 'en-US'], disableRule: '*', enableRule: TYPO_RULES[group] }));
    const out = TYPOGRAFS.get(group).execute(String(text));
    return typeof out === 'string' ? out : null;
  } catch (e) { return null; }
}
const countOf = (s, re) => (String(s).match(re) || []).length;
const MINUS_RE = /(?:^|(?<=[\s([=<>≤≥±~]))-(?=\d)/gmu;

// The typographic dashes among those proseDashes counts in a Russian text: ranges and direct speech, as
// Typograf's range rules place them, and dashes between two numbers. The counted dashes become hyphens for
// Typograf; the other hyphens and dashes are masked so that they do not count.
function typographicDashes(text) {
  const s = String(text || '');
  const counted = new Set([...s.matchAll(DASH_RE)].map((m) => m.index));
  if (!counted.size) return 0;
  const norm = s.replace(/[-–—]/g, (ch, i) => (counted.has(i) ? '-' : ch === '-' ? '\uE000' : '\uE001'));
  const out = typoRun('ranges', norm);
  if (out == null) return 0;
  return countOf(out, /[–—]/g) + countOf(out, /(?<=\d)\s?-\s?(?=\d)/g);
}

// The typography issues of a Russian text: { quotes, hyphenDash, enDash, emDash, minus, nbsp } (counts), or null
// for another language or without Typograf.
function typographyIssues(text) {
  const s = String(text || '');
  if (!s.trim() || textLang(s) !== 'ru' || typeof Typograf !== 'function') return null;
  const quoted = typoRun('quotes', s);
  const dashed = typoRun('dash', s);
  const spaced = typoRun('nbsp', s);
  if (quoted == null || dashed == null || spaced == null) return null;
  return {
    quotes: quoted !== s ? countOf(s, /["“”]/g) : 0,
    hyphenDash: Math.max(0, countOf(s, /-/g) - countOf(dashed, /-/g)),
    enDash: Math.max(0, countOf(s, /–/g) - countOf(dashed, /–/g)),
    emDash: countOf(s, /(?<=\s)—(?=\s)/g),
    minus: countOf(s, MINUS_RE),
    nbsp: Math.max(0, countOf(spaced, /\u00A0/g) - countOf(s, /\u00A0/g)),
  };
}

// The document's own typography: { quotes ('"straight"' | '«guillemets»' | '“curly”' | null), dash ('em' | 'en'
// | null: at least 3 spaced dashes, 80% of one kind), nbsp (it uses no-break spaces), minus (it uses −) }.
function typoHabits(text) {
  const s = String(text || '').slice(0, STYLE_SAMPLE_CHARS);
  const quotes = [['"straight"', countOf(s, /"/g)], ['«guillemets»', countOf(s, /[«»]/g)], ['“curly”', countOf(s, /[“”„]/g)]]
    .filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const em = countOf(s, /(?<=\s)—(?=\s)/g);
  const en = countOf(s, /(?<=\s)–(?=\s)/g);
  const dash = em + en < 3 ? null : em >= 0.8 * (em + en) ? 'em' : en >= 0.8 * (em + en) ? 'en' : null;
  return { quotes: quotes.length ? quotes[0][0] : null, dash, nbsp: countOf(s, /\u00A0/g) >= 3, minus: s.includes('−') };
}

const places = (n) => `${n} place${n === 1 ? '' : 's'}`;
// One "Typography: …" note for what the new text adds over the old one (its own habits are not flagged), with
// the document's habits: quotes only when the document does not use straight or curly quotes itself; en and em
// dashes against the document's dash; minus signs and no-break spaces only in a document that uses them.
function typographyNote(oldText, newText, habits) {
  const b = typographyIssues(newText);
  if (!b) return null;
  const a = (String(oldText || '').trim() && typographyIssues(oldText)) || { quotes: 0, hyphenDash: 0, enDash: 0, emDash: 0, minus: 0, nbsp: 0 };
  const h = habits || {};
  const more = (k) => b[k] > a[k];
  const parts = [];
  if (more('quotes') && (!h.quotes || h.quotes === '«guillemets»')) parts.push('«» quotes expected');
  if (more('hyphenDash')) parts.push(`a hyphen stands for a dash in ${places(b.hyphenDash)}`);
  if (h.dash === 'em' && more('enDash')) parts.push(`an en dash where the document uses — in ${places(b.enDash)}`);
  if (h.dash === 'en' && more('emDash')) parts.push(`an em dash where the document uses – in ${places(b.emDash)}`);
  if (h.minus && more('minus')) parts.push(`a hyphen stands for a minus sign (−) in ${places(b.minus)}`);
  if (h.nbsp && more('nbsp')) parts.push(`no-break spaces missing in ${places(b.nbsp)} (after short words, before units, in "рис. 3")`);
  return parts.length ? `Typography: ${parts.join('; ')}.` : null;
}

// The document's typography habits at the start of the turn, once per snapshot.
function typoHabitsOf(snap) {
  if (!snap) return null;
  if (snap.proseTypo === undefined) {
    const text = (snap.promptView && snap.promptView.docText) || snap.docText;
    snap.proseTypo = text ? typoHabits(text) : null;
  }
  return snap.proseTypo;
}

// ---- Claim drift ---------------------------------------------------------------------------------------------
// Citation markers: numeric brackets ([12], [1, 3], [2–4]: one key per number), author-year in parentheses
// ((Smith, 2020), (Smith et al., 2020; Jones, 2021), (Иванов и др., 2020)) and in the sentence (Smith (2020),
// Smith and Jones (2020)), DOIs. Author-year keys are "surname year", so moving a citation between the two forms
// does not count as a loss.
const NAME = '\\p{Lu}[\\p{L}\'’-]+';
const CITE_BRACKET_RE = /\[(\d+(?:\s*[,–-]\s*\d+)*)\]/gu;
const CITE_PAREN_RE = /\(([^()]*?\d{4}[a-zа-я]?)\)/gu;
const CITE_NARRATIVE_RE = new RegExp(`(${NAME})(?:\\s+(?:et al\\.|и др\\.)|\\s+(?:and|&|и)\\s+${NAME})?\\s*\\((\\d{4}[a-zа-я]?)\\)`, 'gu');
const CITE_ITEM_RE = new RegExp(`(${NAME})[^;]*?(\\d{4}[a-zа-я]?)\\s*$`, 'u');
const DOI_RE = /\b10\.\d{4,9}\/[^\s,;)\]]+/giu;
// Numbers with an optional unit or percent sign ("12.5 %", "5 mg", "37 °C", "p = 0.03", "p < 0.01"). Compared by
// value (numberValue: thousands separators dropped, decimal comma = point, so "0,5", "0.5" and "0.50" are one value,
// "1,000" and "1 000" (a no-break space) are 1000), plus "%", plus the comparator a statistic carries ("p < 0.01" is
// another item than "p = 0.01"; "=" counts as none). The unit is compared when both sides have one (claimDrift).
const UNITS = 'mg|µg|μg|ng|kg|g|ml|mL|µl|μl|l|L|nm|µm|μm|mm|cm|km|m|ms|min|s|h|K|°C|°F|°|Hz|kHz|MHz|mmol|mol|mM|µM|μM|M|kDa|Da|мг|кг|г|мл|л|нм|мкм|мм|см|км|м|мс|мин|с|ч|°С';
// A statistic and its comparator before a number: p, p-value, n, r, t, F, χ², d, OR, HR, CI.
const NUM_STAT = '(?:[pP](?:[- ]values?)?|[nNrRtFd]|[rR]²|χ²|χ2|OR|HR|CI)';
const NUM_CMP = '<=|>=|[=<>≤≥≈~]';
const NUMBER_RE = new RegExp(`(?<![\\p{L}\\p{N}.,])(?:(?<stat>${NUM_STAT})\\s*(?<cmp>${NUM_CMP})\\s*)?(?<num>[-−]?\\d{1,3}(?:[\\u00a0\\u202f\\u2009]\\d{3})+(?:[.,]\\d+)?(?!\\d|[.,]\\d)|[-−]?\\d+(?:[.,]\\d+)*)(?<suf>\\s?%|\\s?(?:${UNITS})(?![\\p{L}\\p{N}]))?`, 'gu');
// Hedges and qualifiers an edit must keep (W11): [regex source, key].
const QUALIFIERS = [
  ['may(?!\\s+\\d)', 'may'], ['might', 'might'], ['could', 'could'], ['suggest(?:s|ed|ing)?', 'suggests'],
  ['appear(?:s|ed)?', 'appears'], ['preliminar(?:y|ily)', 'preliminary'], ['in this sample', 'in this sample'],
  ['tend(?:s|ed)? to', 'tends to'], ['likely', 'likely'],
  ['возможно', 'возможно'], ['вероятно', 'вероятно'], ['по-видимому', 'по-видимому'], ['предварительн\\p{L}*', 'предварительно'],
  ['в данной выборке', 'в данной выборке'], ['как правило', 'как правило'],
].map(([src, key]) => ({ key, re: new RegExp(`(?<![\\p{L}\\p{N}])(?:${src})(?![\\p{L}\\p{N}])`, 'giu') }));

// The value of a number as text: "0,50" → "0.5", "1,000" and "1 000" → "1000", "−3" → "-3" ("0,500" is 0.5: a
// thousands group never starts with 0). Text that is not one number ("1.2.3") stays as written.
function numberValue(digits) {
  let v = String(digits).replace(/−/g, '-').replace(/[\u00a0\u202f\u2009]/g, '');
  v = /^-?[1-9]\d{0,2}(?:,\d{3})+$/.test(v) ? v.replace(/,/g, '') : v.replace(/,/g, '.');
  return /^-?\d+(?:\.\d+)?$/.test(v) ? String(Number(v)) : v;
}
const CMP_NORM = { '=': '', '<=': '≤', '>=': '≥', '~': '≈' };
// Units written differently or in Russian are one unit ("мг" = "mg", "mL" = "ml", "µ" = "μ", "°С" = "°C").
const UNIT_NORM = { мг: 'mg', кг: 'kg', г: 'g', мл: 'ml', л: 'l', нм: 'nm', мкм: 'μm', мм: 'mm', см: 'cm', км: 'km', м: 'm', мс: 'ms', мин: 'min', с: 's', ч: 'h', mL: 'ml', L: 'l' };
const unitKey = (u) => { const t = String(u || '').trim().replace(/µ/g, 'μ').replace(/°С/g, '°C'); return UNIT_NORM[t] || t.replace(/^μL$/, 'μl'); };
// One number of NUMBER_RE: { key, value, cmp, unit, text }. key: comparator + value + "%"; value: the same without
// the comparator (what a user's message names).
function numberItem(m) {
  const g = m.groups;
  const pct = !!g.suf && /%$/.test(g.suf);
  const value = numberValue(g.num) + (pct ? '%' : '');
  const cmp = g.cmp ? (g.cmp in CMP_NORM ? CMP_NORM[g.cmp] : g.cmp) : '';
  // The text names the statistic for a p-value or a comparator other than "=" ("p = 0.03", "n > 30"), else
  // only the number ("n = 48" → "48").
  const text = g.stat && !cmp && !/^p/i.test(g.stat) ? m[0].slice(m[0].lastIndexOf(g.num)) : m[0];
  return { key: cmp + value, value, cmp, unit: g.suf && !pct ? unitKey(g.suf) : '', text: text.trim() };
}
const citeKey = (name, year) => `${name.toLowerCase()} ${year.toLowerCase()}`;

// The claims of a text: { numbers, citations, qualifiers }, each a list of { key, text }.
function claimItems(text) {
  let s = String(text || '');
  const citations = [];
  const blank = (m) => ' '.repeat(m.length);
  s = s.replace(DOI_RE, (m) => { const doi = m.replace(/[.]+$/, ''); citations.push({ key: doi.toLowerCase(), text: doi }); return blank(m); });
  s = s.replace(CITE_BRACKET_RE, (m, inner) => {
    for (const part of inner.split(',')) {
      const r = part.trim().match(/^(\d+)\s*[–-]\s*(\d+)$/);
      const nums = r && Number(r[2]) - Number(r[1]) < 50 ? Array.from({ length: Number(r[2]) - Number(r[1]) + 1 }, (_, i) => Number(r[1]) + i) : [Number(part.trim())];
      for (const n of nums) citations.push({ key: `[${n}]`, text: `[${n}]` });
    }
    return blank(m);
  });
  s = s.replace(CITE_NARRATIVE_RE, (m, name, year) => { citations.push({ key: citeKey(name, year), text: m }); return blank(m); });
  s = s.replace(CITE_PAREN_RE, (m, inner) => {
    const items = inner.split(';').map((p) => p.trim().match(CITE_ITEM_RE)).filter(Boolean);
    if (!items.length) return m; // "(n = 2020)", "(1998–2004)": numbers, not citations
    for (const it of items) citations.push({ key: citeKey(it[1], it[2]), text: `(${it[0].trim()})` });
    return blank(m);
  });
  const numbers = [...s.matchAll(NUMBER_RE)].map(numberItem);
  const src = String(text || '');
  const qualifiers = [];
  for (const { key, re } of QUALIFIERS) for (const m of src.matchAll(re)) qualifiers.push({ key, text: m[0], at: m.index });
  qualifiers.sort((x, y) => x.at - y.at);
  return { numbers, citations, qualifiers };
}

// What old has more often than new (multiset difference on the keys; order does not matter): the texts as old
// had them, each once.
function lostItems(oldList, newList) {
  const have = new Map();
  for (const it of newList) have.set(it.key, (have.get(it.key) || 0) + 1);
  const out = [];
  for (const it of oldList) {
    const n = have.get(it.key) || 0;
    if (n > 0) { have.set(it.key, n - 1); continue; }
    if (!out.includes(it.text)) out.push(it.text);
  }
  return out;
}

// The numbers old has and new lost: the same key (value, percent, comparator) and the same unit, or a unit on one
// side only ("10 min" → "10 minutes"); "37 °C" → "37 K" is lost.
function lostNumbers(oldList, newList) {
  const pool = newList.slice();
  const rest = [];
  for (const it of oldList) {
    const j = pool.findIndex((y) => y.key === it.key && y.unit === it.unit);
    if (j >= 0) pool.splice(j, 1); else rest.push(it);
  }
  const out = [];
  for (const it of rest) {
    const j = pool.findIndex((y) => y.key === it.key && (!y.unit || !it.unit));
    if (j >= 0) pool.splice(j, 1); else if (!out.includes(it.text)) out.push(it.text);
  }
  return out;
}

// The numbers, citations and qualifiers oldText has and newText lost: { numbers, citations, qualifiers } (texts).
function claimDrift(oldText, newText) {
  const a = claimItems(oldText);
  const b = claimItems(newText);
  return {
    numbers: lostNumbers(a.numbers, b.numbers),
    citations: lostItems(a.citations, b.citations),
    qualifiers: [...new Set(lostItems(a.qualifiers, b.qualifiers).map((t) => t.toLowerCase()))],
  };
}

// ---- The beforeWrite hook --------------------------------------------------------------------------------------
// The writing tools that carry new text; delete_lines, format_*, table, page_parts, cite and remember are not
// checked.
const PROSE_TOOLS = ['replace_text', 'replace_all', 'replace_section', 'insert_after_line', 'replace_selection'];
const PROSE_MAX_NOTES = 5;
const KEEP_RATIO = 0.4; // a new text shorter than this share of the old one is an intentional cut: no refusal
const str = (v) => (typeof v === 'string' ? v : '');

// The old and the new text of a write (old is '' for an insert). replace_all: one occurrence (they are all the
// same old_text).
function writeTexts(name, plan, args, snap) {
  if (name === 'insert_after_line') return { oldText: '', newText: str(args.text) };
  if (name === 'replace_selection') return { oldText: str(snap && snap.selection) || str(plan && plan.journal && plan.journal.restore), newText: str(args.text) };
  if (name === 'replace_section') return { oldText: str(plan && plan.section && plan.section.removed), newText: str(args.new_text) };
  return { oldText: str(args.old_text), newText: str(args.new_text) };
}

// The user's text of this turn (its last user message that is not an automatic continuation), or ''.
function turnUserText(snap) {
  const msgs = (snap && snap.chatCtx && snap.chatCtx.messages) || [];
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user' && !msgs[i]._auto) return str(msgs[i].content);
  return '';
}

// A short stable hash of a call (name and arguments), for the per-turn set of refused calls.
function callHash(name, args) {
  const s = name + '\u0000' + JSON.stringify(args || {});
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36) + ':' + s.length;
}

const listText = (items) => items.join(', ');

// beforeWrite(name, plan, args, snap) -> null | { notes, refuse }.
// Refuse: the new text loses numbers or citations of the old one and keeps at least KEEP_RATIO of its length
// (a big cut is deliberate). Items the user's message of this turn names are not counted (the user asked to
// change them), nor citations the References store tracks (the gate card asks about those). The refused call's hash goes into snap.proseRefused (per turn: the snapshot is new every turn);
// the identical call again (same tool, same arguments) passes: the model was told to keep the items or to tell
// the user it removed them on purpose, and a second identical call is that decision.
// Notes: lost qualifiers, and the tells of the new text that the old text does not have already (the author's
// own wording is not flagged); at most PROSE_MAX_NOTES.
function proseCheck(name, plan, args, snap) {
  if (!PROSE_TOOLS.includes(name)) return null;
  const { oldText, newText } = writeTexts(name, plan, args || {}, snap || {});
  if (!newText.trim()) return null;
  const notes = [];
  let refuse;
  if (oldText.trim()) {
    const drift = claimDrift(oldText, newText);
    const asked = claimItems(turnUserText(snap));
    // A number the user names counts by value: "make it p = 0.01" allows dropping "p < 0.01".
    const named = new Set([...asked.numbers.map((it) => it.value), ...asked.citations.map((it) => it.key)]);
    const keyed = claimItems(oldText);
    const keyOf = new Map([...keyed.numbers.map((it) => [it.text, it.value]), ...keyed.citations.map((it) => [it.text, it.key])]);
    // A removed citation the References store tracks (plan.citations) already asks on the gate card: the user decides.
    const tracked = !!(plan && Array.isArray(plan.citations) && plan.citations.length);
    const lost = [...drift.numbers, ...(tracked ? [] : drift.citations)].filter((t) => !named.has(keyOf.get(t)));
    if (lost.length && newText.length >= KEEP_RATIO * oldText.length) {
      const hash = callHash(name, args);
      if (!snap.proseRefused) snap.proseRefused = new Set();
      if (!snap.proseRefused.has(hash)) {
        snap.proseRefused.add(hash);
        refuse = `the new text drops ${listText(lost)}. Keep them, or tell the user you removed them on purpose and call the tool again.`;
      }
    }
    if (drift.qualifiers.length) {
      notes.push(`the new text drops the qualifier${drift.qualifiers.length === 1 ? '' : 's'} ${drift.qualifiers.map((q) => `'${q}'`).join(', ')}; keep ${drift.qualifiers.length === 1 ? 'it' : 'them'} unless the evidence changed.`);
    }
  }
  if (!refuse) {
    const stats = docStatsOf(snap);
    const before = new Map();
    for (const t of proseTells(oldText, stats)) before.set(t.kind + t.match.toLowerCase(), (before.get(t.kind + t.match.toLowerCase()) || 0) + 1);
    for (const t of proseTells(newText, stats)) {
      const k = t.kind + t.match.toLowerCase();
      if (t.kind === 'dashes' && proseDashes(oldText) >= proseDashes(newText)) continue;
      if (before.get(k)) { before.set(k, before.get(k) - 1); continue; }
      notes.push(`'${t.match}' → ${t.hint}.`);
    }
    const typo = typographyNote(oldText, newText, typoHabitsOf(snap));
    if (typo) return { notes: [...notes.slice(0, PROSE_MAX_NOTES - 1), typo], refuse };
  }
  return { notes: notes.slice(0, PROSE_MAX_NOTES), refuse };
}

// The measured style of the document at the start of the turn (docStyleStats, request.js), once per snapshot.
function docStatsOf(snap) {
  if (!snap) return null;
  if (snap.proseStats === undefined) {
    const text = (snap.promptView && snap.promptView.docText) || snap.docText;
    try { snap.proseStats = text ? docStyleStats(text) : null; } catch (e) { snap.proseStats = null; }
  }
  return snap.proseStats;
}

if (typeof registerTurnHook === 'function') registerTurnHook('beforeWrite', proseCheck);
