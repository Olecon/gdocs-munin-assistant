'use strict';
// Module text-segments.js: sentence and word segmentation for the deterministic checks (no model call):
// sentenceSpans / splitSentences(text, lang) and textWords / countWords(text), on Intl.Segmenter with an
// abbreviation merge pass, and textLang(text) (Russian by the share of Cyrillic letters, else English).
// Chrome's sentence segmenter applies UAX #29 without abbreviation lists ("Dr. Smith" and "рис. 3А" split), so
// a segment that ends in a title or pointer abbreviation is joined with the next one. Without Intl.Segmenter
// (an old jsdom) a regex does the same job less well.
// Abbreviation seeds: the CLDR sentence-break suppressions of en.xml and ru.xml (Unicode License v3, © Unicode,
// Inc.), razdel's segmenters/sokr.py (MIT, © 2017 the razdel authors), sbd's English list (MIT, © 2012 Fabiën
// Tesselaar), plus the scientific pointers; the full notices are in vendor/NOTICES.txt.
/* exported textLang, sentenceSpans, splitSentences, endsSentence, textWords, countWords */

// ---- Abbreviations --------------------------------------------------------------------------------------------
// Written without the final period, lowercase; a space inside means "a period and optional spaces" ("т е" matches
// "т. е." and "т.е."). Matched case-insensitively at the end of a segment, after a non-letter.
// HEAD: titles and pointers that always continue the sentence (Dr. Smith, Fig. 3A, рис. 3, см. Рис. 2, e.g. Smith).
const ABBR_HEAD = [
  'dr', 'prof', 'mr', 'mrs', 'ms', 'mx', 'st', 'gen', 'col', 'capt', 'lt', 'sgt', 'gov', 'sen', 'rep', 'hon', 'rev',
  'fig', 'figs', 'eq', 'eqs', 'ref', 'refs', 'tab', 'tabs', 'sect', 'sec', 'secs', 'ch', 'chap', 'suppl', 'cf', 'viz',
  'vs', 'e g', 'i e', 'eg', 'ie',
  'проф', 'акад', 'доц', 'чл корр', 'им', 'св', 'ген', 'зав', 'зам', 'ред', 'под ред', 'рис', 'табл', 'ур', 'гл',
  'разд', 'прил', 'илл', 'см', 'ср', 'напр', 'т е', 'т к', 'т н', 'т ч', 'в т ч',
];
// NUM: pointers to a number: continue only before a digit (p. 5, Vol. 3, Jan. 5, approx. 50%, с. 12, т. 2, ч. 1).
const ABBR_NUM = [
  'p', 'pp', 'no', 'nos', 'vol', 'vols', 'art', 'para', 'approx', 'ca', 'est', 'ed', 'eds',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'с', 'стр', 'т', 'п', 'пп', 'ч', 'ст', 'вып', 'изд', 'ок', 'прим',
  'янв', 'февр', 'апр', 'авг', 'сент', 'окт', 'нояб', 'дек',
];
// END: may close a sentence; continue only when a lowercase word or a bracketed number follows (UAX #29 rule SB8
// mostly keeps that together already: "etc. and", "et al. (2020) showed").
const ABBR_END = [
  'etc', 'et al', 'al', 'inc', 'ltd', 'co', 'corp', 'jr', 'sr', 'a m', 'p m', 'ph d', 'phd',
  'и др', 'и т д', 'и т п', 'т д', 'т п', 'др', 'г', 'гг', 'в', 'вв', 'н э', 'до н э', 'тыс', 'млн', 'млрд', 'руб',
  'коп', 'долл', 'мин', 'сек', 'час', 'кв', 'куб', 'проц', 'см', 'с', 'т', 'ч', 'м', 'км', 'кг', 'мг', 'мл', 'л',
];
// Abbreviations that are also units after a number ("5 см.", "10 с.", "2020 г."): after a digit they are END.
const ABBR_UNIT = new Set(['см', 'с', 'т', 'ч', 'м', 'ст', 'п', 'мин']);

const abbrSource = (list) => list.map((a) => a.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\.\\s*'))
  .sort((x, y) => y.length - x.length).join('|');
const abbrRe = (list) => new RegExp(`(?<![\\p{L}\\p{N}])(${abbrSource(list)})\\.\\s*$`, 'iu');
const ABBR_HEAD_RE = abbrRe(ABBR_HEAD);
const ABBR_NUM_RE = abbrRe(ABBR_NUM);
const ABBR_END_RE = abbrRe(ABBR_END);
// An initial: one capital letter and a period ("А. С. Пушкин", "J. R. R. Tolkien").
const INITIAL_END_RE = /(?<![\p{L}\p{N}])\p{Lu}\.\s*$/u;
const TWO_INITIALS_END_RE = /(?<![\p{L}\p{N}])\p{Lu}\.\s*\p{Lu}\.\s*$/u;
const INITIAL_START_RE = /^\p{Lu}\.(?:\s|$)/u;

// ---- Language --------------------------------------------------------------------------------------------------
// 'ru' when more than 40% of the letters are Cyrillic (a Russian text with Latin terms), else 'en'.
function textLang(text) {
  const s = String(text || '');
  const letters = (s.match(/\p{L}/gu) || []).length;
  const cyr = (s.match(/\p{Script=Cyrillic}/gu) || []).length;
  return letters && cyr / letters > 0.4 ? 'ru' : 'en';
}

// ---- Segmenters ---------------------------------------------------------------------------------------------
const SEGMENTERS = new Map();
function segmenter(lang, granularity) {
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') return null;
  const key = lang + ':' + granularity;
  if (!SEGMENTERS.has(key)) {
    try { SEGMENTERS.set(key, new Intl.Segmenter(lang, { granularity })); } catch (e) { SEGMENTERS.set(key, null); }
  }
  return SEGMENTERS.get(key);
}

// The raw segments of one line: [{ start, text }] (UAX #29, or the regex fallback: a run ending in . ! ? or …
// and the spaces after it, then the rest).
function rawSentences(line, lang) {
  const seg = segmenter(lang, 'sentence');
  if (seg) return Array.from(seg.segment(line), (s) => ({ start: s.index, text: s.segment }));
  const out = [];
  const re = /[^]*?[.!?…]+["»”’)\]]*(?:\s+|$)/gu;
  let m;
  let at = 0;
  while ((m = re.exec(line)) && m[0]) { out.push({ start: m.index, text: m[0] }); at = m.index + m[0].length; }
  if (at < line.length) out.push({ start: at, text: line.slice(at) });
  return out;
}

// Whether a segment ending in cur goes on in next (the abbreviation merge pass).
function continuesInto(cur, next) {
  const tail = cur.trimEnd();
  if (!tail.endsWith('.')) return false;
  const head = next.trimStart();
  if (!head) return false;
  const first = head.replace(/^[("'«“„[]+/u, '');
  const lower = /^\p{Ll}/u.test(first);
  const digit = /^\p{N}/u.test(first);
  const unitAfterNumber = (m) => m && ABBR_UNIT.has(m[1].toLowerCase()) && /\p{N}\s*$/u.test(tail.slice(0, tail.length - m[0].trimEnd().length));
  const h = tail.match(ABBR_HEAD_RE);
  if (h && !unitAfterNumber(h)) return true;
  const n = tail.match(ABBR_NUM_RE);
  if (n && digit && !unitAfterNumber(n)) return true;
  // "и др. (2020).": a year or a reference number in brackets belongs to the citation before it.
  if ((lower || /^[([]\s*\p{N}/u.test(head)) && ABBR_END_RE.test(tail)) return true;
  // Initials: "А. С. Пушкин" (two initials, or an initial before another one); a lone "J. Smith" stays split.
  if (INITIAL_END_RE.test(tail) && (TWO_INITIALS_END_RE.test(tail) || INITIAL_START_RE.test(head))) return true;
  return false;
}

// The sentences of a text: [{ text, start, end }] (text trimmed; start/end its offsets in the text). Lines (\n,
// \v, \r, U+2028/2029) never share a sentence; a line without a final mark (a heading, a list item) is one
// sentence that endsSentence() rejects. lang: a BCP 47 tag; default textLang(text).
function sentenceSpans(text, lang) {
  const s = String(text || '');
  const tag = lang || textLang(s);
  const out = [];
  const lineRe = /[^\n\v\r\u2028\u2029]+/g;
  let lm;
  while ((lm = lineRe.exec(s))) {
    const line = lm[0];
    const segs = rawSentences(line, tag);
    for (let i = 0; i < segs.length; i++) {
      let { start, text: piece } = segs[i];
      while (i + 1 < segs.length && continuesInto(piece, segs[i + 1].text)) piece += segs[++i].text;
      const lead = piece.length - piece.trimStart().length;
      const body = piece.trim();
      if (!body) continue;
      start = lm.index + start + lead;
      out.push({ text: body, start, end: start + body.length });
    }
  }
  return out;
}
const splitSentences = (text, lang) => sentenceSpans(text, lang).map((s) => s.text);
// A sentence proper: it ends in . ! ? or … (closing quotes and brackets allowed after the mark).
const endsSentence = (s) => /[.!?…]["»”’)\]]*$/u.test(String(s || '').trimEnd());

// ---- Words ----------------------------------------------------------------------------------------------------
// The words of a text: UAX #29 word-like segments ("3.5", "1,000", "don't" are one), with words joined by a
// hyphen merged ("well-known", "по-видимому", "methyl-β-cyclodextrin"). Fallback: runs of letters and digits.
const WORD_FALLBACK_RE = /[\p{L}\p{N}]+(?:[.,'’\-\u2010\u2011][\p{L}\p{N}]+)*/gu;
const HYPHENS = new Set(['-', '\u2010', '\u2011']);
function textWords(text) {
  const s = String(text || '');
  const seg = segmenter('en', 'word');
  if (!seg) return s.match(WORD_FALLBACK_RE) || [];
  const out = [];
  let joinNext = false;
  let prev = null; // the previous segment
  for (const part of seg.segment(s)) {
    if (part.isWordLike) {
      if (joinNext && out.length) out[out.length - 1] += '-' + part.segment;
      else out.push(part.segment);
      joinNext = false;
    } else {
      joinNext = HYPHENS.has(part.segment) && prev && prev.isWordLike;
    }
    prev = part;
  }
  return out;
}
const countWords = (text) => textWords(text).length;
