'use strict';
// Module lang-check.js: the language check of a write (no model call). The classic failure it catches: the user asks in
// Russian to improve an English paragraph and the model translates it (or the reverse). langCheck, a beforeWrite hook
// (registry.js), compares the language of the new text with its surroundings: the old text of a replacement (the
// neighbouring body lines when the old text is too short to judge), the neighbouring body lines of an insert. A
// mismatch is a note on the tool result; scientific texts mix languages (terms, titles, citations), so only clear,
// long enough texts are judged. The one refusal: a whole paragraph (or more) clearly in one language replaced by text
// clearly in the other while the chat never asked for a translation.
/* global AGENT_LANGUAGE_LINE, registerTurnHook, sentenceSpans */
/* exported LANG_TOOLS, LANG_MIN_LETTERS, LANG_SHARE, langCounts, langOf, langOddSentences, asksTranslation, langCheck */

// A text is judged only with at least LANG_MIN_LETTERS letters of its alphabet, and when that alphabet has at least
// LANG_SHARE of the Cyrillic and Latin letters (a Russian sentence keeps its Latin terms well under a quarter).
const LANG_MIN_LETTERS = 40;
const LANG_SHARE = 0.75;
// The tools that carry new text (as the writing check; revise_section writes through replace_text).
const LANG_TOOLS = ['replace_text', 'replace_all', 'replace_section', 'insert_after_line', 'replace_selection', 'edit_document'];
const LANG_NEIGHBOURS = 3; // body lines above and below an insert (or a short replacement) that make its surroundings
const LANG_NAME = { en: 'English', ru: 'Russian' };
const langStr = (v) => (typeof v === 'string' ? v : '');

// What never counts: URLs and DOIs, quoted text (a cited title), brackets and parentheses (citations, terms in the
// other language, formulas).
const LANG_DROP_RE = /https?:\/\/\S+|\b10\.\d{4,9}\/\S+|«[^»\n]*»|"[^"\n]*"|“[^”\n]*”|„[^“”\n]*[“”]|\([^()\n]*\)|\[[^\]\n]*\]/gu;
// A reference-list entry: a year or a DOI, and a number or a bracketed number first, "Surname, I." or
// "Surname I. I." first, or the "//" of a Russian (GOST) entry.
const LANG_REF_RE = /^\s*(?:\[\d+\]|\d{1,3}[.)])\s+\S|^\s*\p{Lu}[\p{L}'’-]+,?\s+\p{Lu}\.|\s\/\/\s/u;
const LANG_YEAR_RE = /(?<!\d)(?:1[89]|20)\d\d(?!\d)|\b10\.\d{4,9}\//u;

// The letters of a text that count: { ru, en } (Cyrillic and Latin). A line that is a reference entry, or mostly
// numbers and symbols (a formula, a table row), is skipped.
const langRefLine = (line) => LANG_REF_RE.test(line) && LANG_YEAR_RE.test(line);
function langCounts(text) {
  let ru = 0;
  let en = 0;
  for (const raw of langStr(text).split(/[\n\v\r\u2028\u2029]+/)) {
    if (langRefLine(raw)) continue;
    const line = raw.replace(LANG_DROP_RE, ' ');
    const letters = (line.match(/\p{L}/gu) || []).length;
    const visible = (line.match(/\S/gu) || []).length;
    if (!letters || letters < 0.5 * visible) continue;
    ru += (line.match(/\p{Script=Cyrillic}/gu) || []).length;
    en += (line.match(/\p{Script=Latin}/gu) || []).length;
  }
  return { ru, en };
}

// The language of a text when it is clear: 'ru', 'en', or null (too short, or mixed).
function langOf(text) {
  const { ru, en } = langCounts(text);
  const total = ru + en;
  if (ru >= LANG_MIN_LETTERS && ru >= LANG_SHARE * total) return 'ru';
  if (en >= LANG_MIN_LETTERS && en >= LANG_SHARE * total) return 'en';
  return null;
}

// The sentences of a text that are clearly in another language than lang: [{ text, start, end, lang }].
function langOddSentences(text, lang) {
  if (!lang) return [];
  // Reference entries are blanked first (their sentences lose the year that marks them), keeping the offsets.
  const kept = langStr(text).replace(/[^\n\v\r\u2028\u2029]+/g, (line) => (langRefLine(line) ? ' '.repeat(line.length) : line));
  return sentenceSpans(kept).map((s) => ({ ...s, lang: langOf(s.text) })).filter((s) => s.lang && s.lang !== lang);
}

// Whether a request asks for a translation (or names the target language).
const LANG_TRANSLATE_RE = /translat|перев[оеё]д|по-русски|по-английски|\b(?:in|into|to) (?:russian|english)\b|на (?:русск|английск)/iu;
const asksTranslation = (text) => LANG_TRANSLATE_RE.test(langStr(text));

// The requests of the chat: every message the user wrote (not the panel's automatic ones, _auto, nor a summary, which the
// model wrote; a translation asked for once goes on over later messages, as provenance.js reads the chat), the answers
// to ask_user questions, and inside an agent its task (without the fixed report-language line).
function langRequests(snap) {
  const msgs = ((snap && snap.chatCtx && snap.chatCtx.messages) || []).filter(Boolean);
  const own = snap && Array.isArray(snap.agentMessages) ? snap.agentMessages : [];
  const all = msgs.concat(own);
  const asks = new Set(all.flatMap((m) => (m.role === 'assistant' && Array.isArray(m.tool_calls) ? m.tool_calls : []))
    .filter((tc) => tc && tc.function && tc.function.name === 'ask_user').map((tc) => tc.id));
  const fixed = typeof AGENT_LANGUAGE_LINE === 'string' ? AGENT_LANGUAGE_LINE : '';
  const out = msgs.filter((m) => m.role === 'user' && !m._auto && !m._summary).map((m) => langStr(m.content));
  if (own.length) out.push(fixed ? langStr(own[0].content).split(fixed).join('') : langStr(own[0].content));
  for (const m of all) if (m.role === 'tool' && asks.has(m.tool_call_id)) out.push(langStr(m.content));
  return out.join('\n');
}

// The body lines (no headings, no table cells, not empty) from line a to line b of the model, joined.
function langBodyLines(model, a, b) {
  const lines = (model && model.lines) || [];
  const out = [];
  for (let n = Math.max(1, a); n <= Math.min(lines.length, b); n++) {
    const l = lines[n - 1];
    if (l && !l.heading && !l.cell && String(l.text).trim()) out.push(l.text);
  }
  return out.join('\n');
}
const langNorm = (s) => langStr(s).replace(/\s+/g, ' ').trim();

// Whether old text covers whole lines of the document: lines from..to of the model say (nearly) the same.
function langWholeLines(model, region, oldText) {
  if (/\n/.test(langStr(oldText).trim())) return true;
  if (!model || !Array.isArray(region)) return false;
  const lines = model.lines.slice(region[0] - 1, region[1]).map((l) => l.text).join('\n');
  const a = langNorm(oldText);
  const b = langNorm(lines);
  return !!b && a.length >= 0.9 * b.length && b.includes(a.slice(0, 20));
}

// The parts of a write: [{ oldText, newText, region, at, whole }] (at: the line an insert goes after).
function langParts(name, plan, args, snap) {
  const p = plan || {};
  const model = snap && snap.model;
  const one = (oldText, newText, extra = {}) => ({ oldText: langStr(oldText), newText: langStr(newText), region: p.region, at: null, whole: false, ...extra });
  if (name === 'edit_document' && Array.isArray(p.ops)) {
    return p.ops.filter((o) => o.op === 'replace' || o.op === 'insert').map((o) => (o.op === 'insert'
      ? { oldText: '', newText: langStr(o.raw), region: null, at: Number(o.n) || 0, whole: false }
      : { oldText: langStr(o.given && o.given.old_text), newText: langStr(o.given && o.given.new_text), region: o.region, at: null, whole: langWholeLines(model, o.region, o.given && o.given.old_text) }));
  }
  if (name === 'insert_after_line') return [one('', typeof p.insertedText === 'string' ? p.insertedText : args.text, { region: null, at: Number(args.line) || 0 })];
  if (name === 'replace_section') return [one(p.section && p.section.removed, args.new_text, { whole: true })];
  if (name === 'replace_selection') {
    const old = langStr(snap && snap.selection) || langStr(p.journal && p.journal.restore);
    return [one(old, args.text, { whole: langWholeLines(model, p.region, old) })];
  }
  if (name === 'replace_all') return [one(args.old_text, args.new_text)]; // short phrases: never a whole paragraph
  return [one(args.old_text, args.new_text, { whole: langWholeLines(model, p.region, args.old_text) })];
}

// The language around a part: its old text when clear, else the neighbouring body lines (of the replaced region, or
// above and below an insert).
function langAround(part, model) {
  const own = part.oldText.trim() ? langOf(part.oldText) : null;
  if (own) return own;
  if (!model) return null;
  if (part.at !== null) return langOf(langBodyLines(model, part.at - LANG_NEIGHBOURS + 1, part.at + LANG_NEIGHBOURS));
  if (Array.isArray(part.region)) return langOf(langBodyLines(model, part.region[0] - LANG_NEIGHBOURS, part.region[1] + LANG_NEIGHBOURS));
  return null;
}

const langClip = (s, n = 40) => { const t = langNorm(s); return t.length > n ? t.slice(0, n) + '…' : t; };
const LANG_KEEP = 'Keep the document\'s language unless the user asked for a translation.';

// beforeWrite(name, plan, args, snap) -> null | { notes } | { refuse }. Nothing when the chat asked for a translation.
function langCheck(name, plan, args, snap) {
  if (!LANG_TOOLS.includes(name)) return null;
  const parts = langParts(name, plan, args || {}, snap || {}).filter((p) => p.newText.trim());
  if (!parts.length || asksTranslation(langRequests(snap))) return null;
  const model = snap && snap.model;
  const notes = [];
  for (const part of parts) {
    const around = langAround(part, model);
    if (!around) continue;
    const lang = langOf(part.newText);
    if (lang && lang !== around) {
      // Refused once per call (snap.langRefused, per turn): the identical call again is the model's decision and
      // passes with the note.
      const key = name + '\u0000' + JSON.stringify(args || {});
      const refused = (snap && snap.langRefused) || new Set();
      if (part.whole && langOf(part.oldText) === around && !refused.has(key)) {
        if (snap) snap.langRefused = refused.add(key);
        return { refuse: `this would replace ${around === 'en' ? 'an' : 'a'} ${LANG_NAME[around]} paragraph with ${LANG_NAME[lang]} text. If the user asked for a translation in this chat, call the tool again unchanged; otherwise keep the paragraph's language.` };
      }
      notes.push(`the new text is in ${LANG_NAME[lang]}; the surrounding text is in ${LANG_NAME[around]}. ${LANG_KEEP}`);
      continue;
    }
    // A sentence in the other language inside text of the right one (the author's own such sentences are kept).
    const had = new Set(langOddSentences(part.oldText, around).map((s) => langNorm(s.text)));
    const odd = langOddSentences(part.newText, around).filter((s) => !had.has(langNorm(s.text)));
    if (odd.length) notes.push(`a sentence of the new text is in ${LANG_NAME[odd[0].lang]} ("${langClip(odd[0].text)}"); the surrounding text is in ${LANG_NAME[around]}. ${LANG_KEEP}`);
  }
  return notes.length ? { notes: [...new Set(notes)].slice(0, 2) } : null;
}

if (typeof registerTurnHook === 'function') registerTurnHook('beforeWrite', langCheck);
