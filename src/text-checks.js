'use strict';
// Module text-checks.js: deterministic checks of the text a write puts into the document (no model call), on top of
// the writing check of src/prose-lint.js: textMetrics (sentence length, passive share, nominalizations against the
// document), churnShare (how much of a paragraph a fix request rewrote), abbreviationIssues, unitSpacingIssues and
// figureRefIssues (abbreviations, number-unit spacing, figure/table/equation numbers against the document),
// meaningDrift (negation, modality, comparative and quantifier shifts between old and new text), claimLint (hype,
// "significant" without a test, stacked hedges, universal claims, unattributed claims), statsLint (p-values, ranges,
// ±, means without dispersion, "data is") and the wordy phrases of src/concision.js. textChecks is registered as a
// beforeWrite hook (registry.js): it never refuses; its findings become at most TEXT_NOTE_CHARS characters of notes on
// the write's result. Only what the new text adds is noted: a finding the old text has already is the author's own,
// and a phrase a tell of prose-lint.js reports is not reported twice.
// Rule ideas for claimLint and statsLint follow Vale's journal-style checks and vale-ai-tells (MIT); the word lists are
// written for this project.
// textCheckIgnored(kind, text) of doc-instructions.js (the DOC.md Checks: line) leaves findings out. The baseline of
// textMetrics is the document's; the section a write goes into is named by the section note of src/prose-tools.js.
/* global claimItems, concisionHits, CK_ACRO_ALLOW, countWords, endsSentence, parseHeading, proseTells,
   registerTurnHook, textCheckIgnored, sentenceSpans, STYLE_SAMPLE_CHARS, textLang, textWords, turnUserText, wordDiff, writeTexts */
/* exported TEXT_CHECK_TOOLS, TEXT_NOTE_CHARS, textMetrics, metricsNote, asksFix, churnShare, abbreviationIssues,
   unitSpacingIssues, figureRefIssues, figureMaxima, meaningDrift, driftQualifiers, claimLint, statsLint, wordyNoteItems, textChecks,
   textCheckParts, statsHabits, spacingHabits */

const TEXT_CHECK_TOOLS = ['replace_text', 'replace_all', 'replace_section', 'insert_after_line', 'replace_selection', 'edit_document'];
const TEXT_NOTE_CHARS = 400; // all notes of this module on one result (Munin: 64k context, no cache)
const TEXT_NOTE_ITEMS = 3; // quoted findings per note line, then "+N more"
const tcStr = (v) => (typeof v === 'string' ? v : '');
const tcClip = (s, n = 40) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
const tcWordRe = (src, flags = 'giu') => new RegExp(`(?<![\\p{L}\\p{N}])(?:${src})(?![\\p{L}\\p{N}])`, flags);
const tcCount = (s, re) => { re.lastIndex = 0; return (String(s).match(re) || []).length; };
const tcPct = (x) => Math.round(x * 100);

// The /check ignore list of DOC.md (textCheckIgnored in doc-instructions.js) leaves out a finding of a kind or text.

// ---- Metrics ------------------------------------------------------------------------------------------------------
// Passive voice: a form of "be" and a past participle (regular -ed or a listed irregular one), an adverb or "not"
// allowed between; Russian: a short passive participle after был/будет, or alone with its -о/-ы/-а ending (a stop list
// keeps nouns such as "мембраны" out). Rough on purpose: the same measure runs on the document, so a bias cancels.
const EN_IRREGULAR = 'shown|done|made|given|taken|seen|known|found|held|kept|set|put|run|chosen|drawn|grown|written|built|sent|spent|brought|'
  + 'thought|bought|led|left|lost|met|paid|read|said|sold|told|understood|begun|broken|driven|fallen|frozen|hidden|risen|shaken|spoken|'
  + 'bound|cut|hit|shut|split|spread|struck|undertaken|withdrawn|seen|born|worn|torn';
const PASSIVE_EN_RE = new RegExp(`(?<![\\p{L}])(?:am|is|are|was|were|be|been|being)\\s+(?:\\p{L}+ly\\s+|not\\s+)?(?:\\p{L}{2,}ed|${EN_IRREGULAR})(?![\\p{L}])`, 'iu');
const PASSIVE_RU_RE = /(?<![\p{L}])(?:(?:был[аио]?|будет|будут)\s+\p{L}{2,}(?:ан|ян|ен|ён|т)[аоы]?|\p{L}{3,}(?:ан|ян|ен|ён)[оы]|\p{L}{3,}(?:ован|ирован)а)(?![\p{L}])/iu;
const PASSIVE_RU_NOT = /(?<![\p{L}])(?:мембран|экран|стран|охран|сторон|цен|стен|смен|замен|арен|сцен|антенн|колен|вен|сирен|фен|времен|имен|племен|знамен|семен|бремен|окн|сукн)[аоы](?![\p{L}])/giu;
const passiveSentence = (s, lang) => (lang === 'ru' ? PASSIVE_RU_RE.test(s.replace(PASSIVE_RU_NOT, ' ')) : PASSIVE_EN_RE.test(s));
// Nominalizations: -tion/-sion/-ment/-ance/-ence/-ity nouns of 7+ letters; Russian -ние/-ция/-ость in all cases.
const NOMINAL_EN_RE = /(?<![\p{L}])\p{L}{3,}(?:tions?|sions?|ments?|ances?|ences?|ity|ities)(?![\p{L}])/giu;
const NOMINAL_RU_RE = /(?<![\p{L}])\p{L}{2,}(?:ни[еяюий]|ние[м]|ци[яиюей]|цией|ость|ости|остью|остей|остям|остями|остях)(?![\p{L}])/giu;

// The measures of a text: { lang, sentences, words, mean, min, max, passive (share of the sentences), nominal (per 100
// words) }, or null with fewer than minSentences full sentences. Only full sentences count (not headings or list labels).
function textMetrics(text, minSentences = 2) {
  const s = String(text || '');
  const lang = textLang(s);
  const lens = [];
  let passive = 0;
  for (const sp of sentenceSpans(s, lang)) {
    if (!endsSentence(sp.text)) continue;
    const n = countWords(sp.text);
    if (n < 3) continue;
    lens.push(n);
    if (passiveSentence(sp.text, lang)) passive++;
  }
  if (lens.length < minSentences) return null;
  const words = lens.reduce((a, b) => a + b, 0);
  const nominal = tcCount(s, lang === 'ru' ? NOMINAL_RU_RE : NOMINAL_EN_RE);
  return {
    lang, sentences: lens.length, words, mean: Math.round(words / lens.length), min: Math.min(...lens), max: Math.max(...lens),
    passive: passive / lens.length, nominal: Math.round((nominal * 1000) / Math.max(1, countWords(s))) / 10,
  };
}

const METRIC_MIN_WORDS = 40; // a shorter new text says too little about its style
const METRIC_LONGER = 1.4; // mean sentence length above this share of the document's (and 5+ words more)
const METRIC_PASSIVE = 2; // passive share above twice the document's (and at least 25%, 2 sentences)
const METRIC_NOMINAL = 1.5; // nominalizations above 1.5× the document's (and 2+ per 100 words more)

// The metrics note of a new text against a baseline (the document's metrics): '' when nothing
// differs clearly. old: the metrics of the replaced text; a measure the old text already had is not flagged unless the
// new text goes 10% further.
function metricsNote(neu, base, old) {
  if (!neu || !base || neu.words < METRIC_MIN_WORDS) return '';
  const ownAlready = (k) => old && old[k] > 0 && neu[k] <= old[k] * 1.1;
  const parts = []; // verb phrases after "your text"
  if (base.mean > 0 && neu.mean > METRIC_LONGER * base.mean && neu.mean >= base.mean + 5 && !ownAlready('mean')) {
    parts.push(`averages ${neu.mean} words per sentence (${neu.min}–${neu.max}; document: ${base.mean})`);
  }
  const passiveCount = Math.round(neu.passive * neu.sentences);
  if (base.passive != null && neu.passive > METRIC_PASSIVE * base.passive && neu.passive >= 0.25 && passiveCount >= 2 && !ownAlready('passive')) {
    parts.push(`is ${tcPct(neu.passive)}% passive (document: ${tcPct(base.passive)}%)`);
  }
  if (base.nominal != null && neu.nominal > METRIC_NOMINAL * base.nominal && neu.nominal >= base.nominal + 2 && !ownAlready('nominal')) {
    parts.push(`has ${neu.nominal} ${neu.lang === 'ru' ? '-ние/-ция/-ость' : '-tion/-ment'} nouns per 100 words (document: ${base.nominal})`);
  }
  if (!parts.length) return '';
  const joined = parts.length === 1 ? parts[0] : parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
  return `your text ${joined}.`;
}

// ---- Churn of a fix request -----------------------------------------------------------------------------------------
// A fix, polish or tighten request (English and Russian cue words), unless the message also asks for a rewrite.
const FIX_RE = tcWordRe('fix(?:es|ed)?|correct|proofread|polish|tighten|improve|tweak|clean up|smooth(?: out)?|typos?|grammar|spelling|'
  + 'исправ\\p{L}*|поправ\\p{L}*|подправ\\p{L}*|улучш\\p{L}*|отшлифу\\p{L}*|шлиф\\p{L}*|вычит\\p{L}*|подтян\\p{L}*|причеш\\p{L}*|'
  + 'опечат\\p{L}*|граммат\\p{L}*|орфограф\\p{L}*|пунктуац\\p{L}*|отредактир\\p{L}*|редактур\\p{L}*', 'iu');
const REWRITE_RE = tcWordRe('rewrite|rewrit\\p{L}*|rephrase|paraphrase|restructure|redo|redraft|from scratch|'
  + 'перепиш\\p{L}*|перепис\\p{L}*|перефразир\\p{L}*|переформулир\\p{L}*|переделай|с нуля', 'iu');
const asksFix = (msg) => FIX_RE.test(String(msg || '')) && !REWRITE_RE.test(String(msg || ''));
const CHURN_MIN_WORDS = 12; // a phrase is not a paragraph
const CHURN_LIMIT = 0.6;
const CHURN_MAX_CELLS = 250000; // word-diff.js turns a larger middle into one deletion and one insertion

// The share of changed words between two texts, 0–1: (removed + inserted words) / (old + new words), paragraph by
// paragraph when both have as many paragraphs; null for a short old text or one too long to diff.
function churnShare(oldText, newText) {
  const a = String(oldText || '');
  const b = String(newText || '');
  const total = countWords(a) + countWords(b);
  if (countWords(a) < CHURN_MIN_WORDS || !total) return null;
  const pa = a.split(/\n+/);
  const pb = b.split(/\n+/);
  const pairs = pa.length === pb.length ? pa.map((x, i) => [x, pb[i]]) : [[a, b]];
  let changed = 0;
  for (const [x, y] of pairs) {
    if ((countWords(x) * 2) * (countWords(y) * 2) > CHURN_MAX_CELLS) return null; // tokens ≈ words and spaces
    for (const [op, t] of wordDiff(x, y)) if (op) changed += countWords(t);
  }
  return Math.min(1, changed / total);
}

// ---- Abbreviations ------------------------------------------------------------------------------------------------
// 2–6 capitals (digits allowed, a plural "s"); not a Roman numeral, a mutation (C87S) or a formula (H2O).
const ABBR_RE = /(?<![\p{L}\p{N}_])(\p{Lu}[\p{Lu}\p{N}]{1,7})s?(?![\p{L}\p{N}_])/gu;
const ABBR_KNOWN = new Set(['DNA', 'RNA', 'PCR', 'USA', 'UK', 'EU', 'UN', 'WHO', 'ATP', 'UV', 'IR', 'NMR', 'HPLC', 'PDF', 'URL', 'DOI', 'ID',
  'OK', 'AM', 'PM', 'AD', 'BC', 'CE', 'BCE', 'EUR', 'USD', 'GBP', 'RUB', 'SD', 'SE', 'SEM', 'CI', 'IQR', 'OR', 'HR', 'ANOVA', 'ISBN', 'ISSN', 'ДНК', 'РНК', 'США', 'РФ', 'ООН', 'РАН', 'ВОЗ']);
const abbrValid = (tok) => {
  const caps = (tok.match(/\p{Lu}/gu) || []).length;
  return caps >= 2 && caps <= 6 && !/^X{0,3}(?:IX|IV|V?I{0,3})$/.test(tok) && !/^\p{Lu}\d+\p{Lu}$/u.test(tok) && !/\d\p{Lu}/u.test(tok);
};
const abbrKnown = (k) => ABBR_KNOWN.has(k) || (typeof CK_ACRO_ALLOW !== 'undefined' && CK_ACRO_ALLOW.has(k));
// The abbreviations a text defines: "long form (ABC)", "(hereafter ABC)", "ABC (long form …)", with their offsets.
function abbrDefinitions(text) {
  const out = [];
  for (const m of String(text).matchAll(/\(\s*(?:hereafter|hereinafter|далее)?\s*[-–—:]?\s*(\p{Lu}[\p{Lu}\p{N}]{1,7})s?\s*[),;]/gu)) {
    if (/[\p{L}\p{N}][\s\u00a0]*$/u.test(String(text).slice(0, m.index))) out.push({ key: m[1], at: m.index });
  }
  for (const m of String(text).matchAll(/(?<![\p{L}\p{N}])(\p{Lu}[\p{Lu}\p{N}]{1,7})s?\s*\(\s*\p{Ll}+[\s-]+\p{L}+/gu)) out.push({ key: m[1], at: m.index });
  return out;
}
// What the document has: { used (its abbreviations, defined or not), words (its words in lowercase: "GAMMA" for a
// "gamma" of the document is emphasis, not an abbreviation) }.
function abbrDocIndex(docText) {
  const doc = String(docText || '');
  const used = new Set();
  for (const m of doc.matchAll(ABBR_RE)) used.add(m[1]);
  for (const d of abbrDefinitions(doc)) used.add(d.key);
  return { used, words: new Set(textWords(doc.toLowerCase())) };
}
// The abbreviations of the new text that the document neither uses nor defines and the new text uses before it defines
// them (or never defines): their texts. A word of an all-caps line (a heading) is not one, nor one of a line that heads
// (a heading or a title defines nothing). doc: the document's text or its abbrDocIndex; heads: true per line of newText
// that heads (textCheckParts).
function abbreviationIssues(newText, doc, heads = null) {
  const { used, words } = typeof doc === 'object' && doc ? doc : abbrDocIndex(doc);
  const s = String(newText || '');
  const defs = abbrDefinitions(s);
  const out = [];
  let at = 0;
  for (const [i, line] of s.split('\n').entries()) {
    if (/\p{Ll}/u.test(line) && !(heads && heads[i])) {
      for (const m of line.matchAll(ABBR_RE)) {
        const k = m[1];
        if (!abbrValid(k) || used.has(k) || words.has(k.toLowerCase()) || abbrKnown(k) || out.includes(k)) continue;
        const pos = at + m.index;
        if (defs.some((d) => d.key === k && d.at <= pos + k.length + 3)) continue; // defined here or before
        out.push(k);
      }
    }
    at += line.length + 1;
  }
  return out;
}

// ---- Number–unit spacing ---------------------------------------------------------------------------------------------
// Units of two or more characters (a lone "m", "s" or "K" is too often something else), "%" and degrees.
const SPACING_UNITS = 'mg|µg|μg|ng|kg|ml|mL|µl|μl|µL|μL|nm|µm|μm|mm|cm|km|ms|min|Hz|kHz|MHz|GHz|mmol|mol|mM|µM|μM|nM|kDa|Da|kV|mV|mA|kW|'
  + 'мг|мкг|кг|мл|мкл|нм|мкм|мм|см|км|мс|мин|мМ|мкМ|кДа|%|°C|°С|°F|°';
const SPACING_RE = new RegExp(`(?<![\\p{L}\\p{N}.,])(\\d+(?:[.,]\\d+)?)([ \\u00a0\\u202f\\u2009]?)(${SPACING_UNITS})(?![\\p{L}\\p{N}])`, 'gu');
const spacingGroup = (unit) => (unit === '%' ? 'percent' : unit.startsWith('°') ? 'degree' : 'unit');
// The document's dominant form per group: { percent|degree|unit: 'spaced' | 'tight' } (4+ cases, 75% one form).
function spacingHabits(docText) {
  const n = {};
  for (const m of String(docText || '').matchAll(SPACING_RE)) {
    const g = spacingGroup(m[3]);
    n[g] = n[g] || { spaced: 0, tight: 0 };
    n[g][m[2] ? 'spaced' : 'tight']++;
  }
  const out = {};
  for (const [g, c] of Object.entries(n)) {
    const all = c.spaced + c.tight;
    if (all >= 4 && Math.max(c.spaced, c.tight) >= 0.75 * all) out[g] = c.spaced > c.tight ? 'spaced' : 'tight';
  }
  return out;
}
// The new text's number–unit pairs written against the document's dominant form: [{ text, want }].
function unitSpacingIssues(newText, habits) {
  const out = [];
  for (const m of String(newText || '').matchAll(SPACING_RE)) {
    const want = habits && habits[spacingGroup(m[3])];
    if (!want || (want === 'spaced') === !!m[2]) continue;
    out.push({ text: m[0], want: want === 'spaced' ? `${m[1]} ${m[3]}` : `${m[1]}${m[3]}` });
  }
  return out;
}

// ---- Figure, table and equation numbers --------------------------------------------------------------------------------
const NUM_LIST = '(\\d+[a-zа-я]?(?:\\s*(?:[,–—-]|and|&|и)\\s*\\d+[a-zа-я]?)*)';
const TARGET_RE = {
  figure: new RegExp(`(?<![\\p{L}])(?:fig(?:ure)?s?\\.?|рис(?:\\.|ун\\p{L}*))\\s*${NUM_LIST}`, 'giu'),
  table: new RegExp(`(?<![\\p{L}])(?:tables?|tab\\.|табл(?:\\.|иц\\p{L}*))\\s*${NUM_LIST}`, 'giu'),
  equation: /(?<![\p{L}])(?:eqs?\.|equations?|ур\.|уравнени\p{L}*)\s*\(?\s*(\d+)\s*\)?/giu,
};
const TARGET_LABEL = { figure: 'figures', table: 'tables', equation: 'equations' };
const targetNumbers = (list) => (String(list).match(/\d+/g) || []).map(Number).filter((n) => n > 0 && n < 1000);
// The highest number per kind the document mentions or captions ({ figure, table, equation }; 0 = none); an equation
// also counts by its "(n)" at the end of a formula line.
function figureMaxima(docText) {
  const s = String(docText || '');
  const max = { figure: 0, table: 0, equation: 0 };
  for (const kind of Object.keys(TARGET_RE)) for (const m of s.matchAll(TARGET_RE[kind])) max[kind] = Math.max(max[kind], ...targetNumbers(m[1]));
  for (const line of s.split('\n')) {
    const eq = /[=≈<>≤≥].*\(\s*(\d+)\s*\)\s*[.,;]?\s*$/.exec(line);
    if (eq) max.equation = Math.max(max.equation, Number(eq[1]));
  }
  return max;
}
// A caption at a line start ("Figure 4.", "Табл. 2 –"): the new text brings its own target.
const OWN_CAPTION_RE = /^\s*(?:(figure|fig\.?|рис\.|рисунок)|(table|tab\.|таблица|табл\.))\s*(\d+)[a-zа-я]?\s*(?:[.:|—–-]|$)/gimu;
// The references of the new text past the document's highest number: [{ text, kind, max }]. Only in a document with
// at least one target of the kind, or with enough text (docWords ≥ 300) to have them; a caption in the new text counts.
function figureRefIssues(newText, maxima, docWords = 0) {
  const out = [];
  const own = { figure: 0, table: 0, equation: 0 };
  for (const m of String(newText || '').matchAll(OWN_CAPTION_RE)) { const k = m[1] ? 'figure' : 'table'; own[k] = Math.max(own[k], Number(m[3])); }
  for (const kind of Object.keys(TARGET_RE)) {
    const max = Math.max((maxima && maxima[kind]) || 0, own[kind]);
    if (!max && docWords < 300) continue;
    for (const m of String(newText || '').matchAll(TARGET_RE[kind])) {
      if (targetNumbers(m[1]).some((n) => n > max) && !out.some((o) => o.text === m[0].trim())) out.push({ text: m[0].trim(), kind, max });
    }
  }
  return out;
}

// ---- Meaning drift ---------------------------------------------------------------------------------------------------
const NEG_RE = tcWordRe("no|not|never|without|neither|nor|none|nothing|cannot|\\p{L}+n['’]t|не|нет|без|ни|никогда|ничего|нельзя");
const HEDGE_RE = tcWordRe('may|might|could|possibly|perhaps|likely|presumably|potentially|suggest(?:s|ed)?|appear(?:s|ed)?|seem(?:s|ed)?|'
  + 'indicat(?:e|es|ed)|возможно|вероятно|по-видимому|видимо|предположительно|может|могут|мог|могла|могли|указыва(?:ет|ют)|'
  + 'предполага(?:ет|ют)|по-видимому');
const PROOF_RE = tcWordRe('prove[sdn]?|proven|demonstrat(?:e|es|ed)|establish(?:es|ed)?|confirm(?:s|ed)?|clearly|definitely|certainly|'
  + 'доказ(?:ывает|ывают|ал|ала|али|ано)|подтвержда(?:ет|ют)|подтвердил[аи]?|однозначно|несомненно');
const QUANT_RE = tcWordRe('all|always|every|everyone|everything|never|entirely|completely|invariably|universally|'
  + 'все|всё|всех|всем|всеми|всегда|никогда|каждый|каждая|каждое|каждого|любой|любая|любое');
// Opposite pairs (stems for Russian): one side in the removed words and the other in the inserted ones is a flip.
const OPPOSITES = [
  ['higher', 'lower'], ['increase[sd]?|increasing|rise[sn]?|rose|gain(?:s|ed)?', 'decrease[sd]?|decreasing|reduce[sd]?|reducing|decline[sd]?|fall(?:s|en)?|fell|drop(?:s|ped)?|lo(?:ss|st)'],
  ['more', 'less|fewer'], ['faster', 'slower'], ['greater|larger|bigger', 'smaller'], ['above', 'below'], ['better', 'worse'],
  ['positive(?:ly)?', 'negative(?:ly)?'], ['maximum|maximal|highest', 'minimum|minimal|lowest'], ['strong(?:er|est)?', 'weak(?:er|est)?'],
  ['выше', 'ниже'], ['больше', 'меньше'], ['быстрее', 'медленнее'], ['сильнее', 'слабее'], ['лучше', 'хуже'],
  ['рост\\p{L}*|рос(?:ла|ло|ли)?|вырос\\p{L}*|увелич\\p{L}*|повыш\\p{L}*', 'сниж\\p{L}*|сниз\\p{L}*|уменьш\\p{L}*|паден\\p{L}*|упал\\p{L}*'],
  ['положительн\\p{L}*', 'отрицательн\\p{L}*'], ['максимальн\\p{L}*', 'минимальн\\p{L}*'],
].map(([a, b]) => [tcWordRe(a, 'iu'), tcWordRe(b, 'iu')]);
const DRIFT_MAX_WORDS = 8; // a longer change is a rewrite: its pairs say nothing quotable

// The changed spans of a rewrite: [{ del, ins, before, after }] (before/after: the kept word next to the change).
function driftHunks(oldText, newText) {
  const ops = wordDiff(oldText, newText);
  const out = [];
  for (let i = 0; i < ops.length; i++) {
    if (!ops[i][0]) continue;
    let del = '', ins = '';
    const start = i;
    for (; i < ops.length && ops[i][0]; i++) { if (ops[i][0] < 0) del += ops[i][1]; else ins += ops[i][1]; }
    const prev = start > 0 ? ops[start - 1][1] : '';
    const next = i < ops.length ? ops[i][1] : '';
    i--;
    const edge = (t) => t.replace(/^[\s,;:]+|[\s,;:]+$/g, ''); // ", возможно," is quoted "возможно"
    out.push({ del: edge(del), ins: edge(ins), before: (prev.match(/([\p{L}\p{N}]+)[^\p{L}\p{N}]*$/u) || ['', ''])[1], after: (next.match(/^\s*([\p{L}\p{N}]+)/u) || ['', ''])[1] });
  }
  return out;
}
// The quoted pair of a hunk: a change of one word or less on each side takes the next kept word (or the one before) on
// both sides ("no" → "an" is quoted "no effect" → "an effect"); a longer insertion or deletion is 'added "…"' or
// 'dropped "…"'.
function driftQuote(h) {
  const short = countWords(h.del) < 2 && countWords(h.ins) < 2;
  if (!short && !h.del) return `added "${tcClip(h.ins)}"`; // a longer pure insertion or deletion has no pair
  if (!short && !h.ins) return `dropped "${tcClip(h.del)}"`;
  const wrap = (t) => (short ? (h.after ? [t, h.after] : [h.before, t]) : [t]).filter(Boolean).join(' ');
  return `"${tcClip(wrap(h.del))}" → "${tcClip(wrap(h.ins))}"`;
}
// The meaning shifts between an old and a new text: [{ kind ('negation' | 'modality' | 'comparative' | 'quantifier'),
// pair (quoted), lost (the qualifiers of claimItems the change drops, lowercase, as claimDrift names them) }].
function meaningDrift(oldText, newText) {
  const out = [];
  for (const h of driftHunks(oldText, newText)) {
    if (countWords(h.del) > DRIFT_MAX_WORDS || countWords(h.ins) > DRIFT_MAX_WORDS) continue;
    const n = (re, t) => tcCount(t, re);
    let kind = null;
    if (n(NEG_RE, h.del) !== n(NEG_RE, h.ins)) kind = 'negation';
    else if (n(HEDGE_RE, h.del) !== n(HEDGE_RE, h.ins) || n(PROOF_RE, h.del) !== n(PROOF_RE, h.ins)) kind = 'modality';
    else if (OPPOSITES.some(([a, b]) => (a.test(h.del) && b.test(h.ins) && !b.test(h.del)) || (b.test(h.del) && a.test(h.ins) && !a.test(h.del)))) kind = 'comparative';
    else if (n(QUANT_RE, h.ins) > n(QUANT_RE, h.del)) kind = 'quantifier';
    if (!kind) continue;
    const pair = driftQuote(h);
    if (out.some((o) => o.pair === pair)) continue;
    const keep = new Set(claimItems(h.ins).qualifiers.map((q) => q.key));
    out.push({ kind, pair, lost: [...new Set(claimItems(h.del).qualifiers.filter((q) => !keep.has(q.key)).map((q) => q.text.toLowerCase()))] });
  }
  return out;
}
// The qualifiers a modality pair of meaningDrift reports (not ignored), so that prose-lint.js does not also note
// them as dropped qualifiers.
function driftQualifiers(oldText, newText) {
  if (!String(oldText || '').trim()) return [];
  return meaningDrift(oldText, newText).filter((d) => d.kind === 'modality' && !textCheckIgnored('drift', d.pair)).flatMap((d) => d.lost);
}

// ---- Claim strength ----------------------------------------------------------------------------------------------------
const HYPE_RE = tcWordRe('novel|unprecedented|first[- ]ever|for the first time|clearly|obviously|undoubtedly|conclusively|definitively|'
  + 'prove[sd]?|proven|groundbreaking|breakthrough|revolutionary|remarkabl[ey]|'
  + 'впервые|беспрецедентн\\p{L}*|революционн\\p{L}*|прорывн\\p{L}*|доказ(?:ывает|ывают|ал|ала|али|ано)|несомненно|безусловно|очевидно');
const SIGNIFICANT_RE = tcWordRe('(?:statistically )?significant(?:ly)?|(?:статистически )?(?:значим|достоверн)\\p{L}*');
// A statistic in the sentence: p or P with a comparator, CI, a named test, χ², a percentage interval, SD/SE, ±.
const STAT_MARK_RE = /(?<![\p{L}])[pP]\s*[<=>≤≥]|(?<![\p{L}])(?:CI|SD|SE|SEM|ANOVA|t-test|χ²|χ2|chi-square|Mann|Wilcoxon|Fisher|Student)(?![\p{L}])|95\s?%|±|доверительн|критери/u;
const STACKED_RE = tcWordRe('(?:may|might|could) (?:potentially|possibly|perhaps|conceivably|presumably)|possibly (?:may|might|could)|'
  + '(?:seems?|appears?) to (?:suggest|indicate)|(?:may|might|could) (?:suggest|indicate) (?:a )?(?:possible|potential)|'
  + '(?:возможно|вероятно),? (?:может|могут|мог|могла|могли)|может,? вероятно');
const UNIVERSAL_RE = tcWordRe('always|never|invariably|universally|in all cases|without exception|всегда|никогда|без исключения|во всех случаях');
const ATTRIB_RE = tcWordRe('(?:studies|research|evidence|literature) (?:shows?|has shown|have shown|suggests?|indicates?)|'
  + 'it is (?:well[- ])?(?:known|established|accepted)(?: that)?|scientists (?:agree|believe)|experts (?:agree|believe|say)|'
  + 'известно,? что|исследования показ\\p{L}*|принято считать|многие (?:авторы|исследователи|уч[её]ные)');
const CITE_MARK_RE = /\[\d+(?:\s*[,–-]\s*\d+)*\]|[¹²³⁴⁵⁶⁷⁸⁹⁰]|\(\s*\p{Lu}[\p{L}'’-]+[^()]*\d{4}[a-zа-я]?\s*\)|\p{Lu}[\p{L}'’-]+(?:\s+et al\.|\s+и др\.)?\s*\(\d{4}\)/u;
// The claim findings of a text: [{ kind, match, label }] (label: how the note names it).
function claimLint(text) {
  const out = [];
  for (const sp of sentenceSpans(String(text || ''))) {
    const t = sp.text;
    const add = (re, kind, label) => { re.lastIndex = 0; for (const m of t.matchAll(re)) out.push({ kind, match: m[0], label: label(m[0]) }); };
    add(HYPE_RE, 'hype', (m) => `"${m}" (hype)`);
    if (!STAT_MARK_RE.test(t)) add(SIGNIFICANT_RE, 'significant', (m) => `"${m}" without a test`);
    add(STACKED_RE, 'stacked', (m) => `"${m}" (one hedge is enough)`);
    add(UNIVERSAL_RE, 'universal', (m) => `"${m}" (universal claim)`);
    if (!CITE_MARK_RE.test(t)) add(ATTRIB_RE, 'attribution', (m) => `"${m}" without a citation`);
  }
  return out;
}

// ---- Statistics ---------------------------------------------------------------------------------------------------------
const P_RE = /(?<![\p{L}\p{N}])([pP])(\s*)([<=>≤≥])(\s*)(0?[.,]\d+|0|1)(?![\d])/gu;
const RANGE_RE = /(?<![\p{L}\p{N}.,\-–])(\d+(?:[.,]\d+)?)([-–])(\d+(?:[.,]\d+)?)(?![\p{L}\p{N}\-–]|[.,]\d)/gu;
// Case-sensitive: "M = 5" is a mean, "m = 5 kg" a mass.
const MEAN_RE = /(?<![\p{L}\p{N}])(?:[Mm]ean|[Aa]verage[ds]?|[Сс]реднее|[Вв] среднем|[Сс]редн\p{L}* значени\p{L}*)(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])M\s*=/u;
const SPREAD_RE = /(?<![\p{L}])(?:SD|SE|SEM|CI|IQR|s\.d\.|s\.e\.|standard (?:deviation|error)|range|confidence interval|ст\.\s?откл|стандартн\p{L}* (?:отклонени|ошибк)\p{L}*|доверительн\p{L}*|разброс\p{L}*)(?![\p{L}])|±/iu;
const DATA_SING_RE = tcWordRe('(?:the |this |our |these )?data (?:is|was|shows|suggests|indicates|has)|this data');
const DATA_PLUR_RE = tcWordRe('data (?:are|were|show|suggest|indicate|have)|these data');
// The document's statistics habits: { pSpaced, pCase ('p' | 'P'), ranges ('en' | 'hyphen'), dataPlural } (null where
// the document has too few cases: 3 and 75% one form).
function statsHabits(docText) {
  const s = String(docText || '');
  const dom = (a, b) => (a + b >= 3 && Math.max(a, b) >= 0.75 * (a + b) ? a > b : null);
  let spaced = 0, tight = 0, lower = 0, upper = 0, en = 0, hyph = 0;
  for (const m of s.matchAll(P_RE)) { if (m[2] && m[4]) spaced++; else if (!m[2] && !m[4]) tight++; if (m[1] === 'p') lower++; else upper++; }
  for (const m of s.matchAll(RANGE_RE)) if (m[2] === '–') en++; else hyph++;
  const sp = dom(spaced, tight);
  const lc = dom(lower, upper);
  const rg = dom(en, hyph);
  return {
    pSpaced: sp, pCase: lc == null ? null : lc ? 'p' : 'P', ranges: rg == null ? null : rg ? 'en' : 'hyphen',
    dataPlural: tcCount(s, DATA_PLUR_RE) > tcCount(s, DATA_SING_RE),
  };
}
// The numerals that start a sentence. Found on the text, not on sentenceSpans: UAX #29 keeps "… clear. 12 samples were"
// together (a period before a number and a lowercase word is no break). Not after a pointer abbreviation ("Fig. 3
// shows"), not a numbered list item ("1. Mix") or a numbered heading line.
const NUMERAL_START_RE = /(?:^|(\S+?)[.!?]["»”’)\]]*[ \t\u00a0]+)(["«“„(]?)(\d[\d.,]*%?)(?=[ \t\u00a0]+\p{L})/gmu;
const NUMERAL_POINTER_RE = /(?:^|[^\p{L}])(?:figs?|eqs?|refs?|tabs?|no|nos|vol|pp?|approx|ca|sect?|ch|рис|табл|ур|см|с|стр|т|п|ч|гл|разд|ок)$/iu;
function numeralStarts(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!endsSentence(line)) continue; // a heading or a label
    for (const m of line.matchAll(NUMERAL_START_RE)) {
      if (m[1] != null && NUMERAL_POINTER_RE.test(m[1])) continue;
      if (/^\d+[.)]$/.test(m[3]) || (m[1] == null && /^\d+(?:[.)]|\.\d)/.test(line.trimStart()))) continue; // "1. Mix", "1) Mix", "2.1 Methods"
      out.push(m[3].replace(/[.,]$/, ''));
    }
  }
  return out;
}

// The statistics findings of a text against the document's habits: [{ kind, match, label }].
function statsLint(text, habits) {
  const s = String(text || '');
  const h = habits || {};
  const out = [];
  for (const m of s.matchAll(P_RE)) {
    if (m[3] === '=' && /^0?[.,]?0*$/.test(m[5])) { out.push({ kind: 'p-zero', match: m[0], label: `"${m[0]}" (write p < 0.001)` }); continue; }
    const spaced = !!(m[2] && m[4]);
    const tight = !m[2] && !m[4];
    if ((h.pSpaced === true && !spaced) || (h.pSpaced === false && !tight) || (h.pCase && m[1] !== h.pCase)) {
      const sep = h.pSpaced === true ? ' ' : h.pSpaced === false ? '' : spaced ? ' ' : '';
      out.push({ kind: 'p-form', match: m[0], label: `"${m[0]}" (the document writes "${h.pCase || m[1]}${sep}${m[3]}${sep}${m[5]}")` });
    }
  }
  if (h.ranges === 'en') for (const m of s.matchAll(RANGE_RE)) if (m[2] === '-') out.push({ kind: 'range', match: m[0], label: `"${m[0]}" (an en dash: ${m[1]}–${m[3]})` });
  for (const m of s.matchAll(/\+\/-|\+-(?=\s*\d)/g)) out.push({ kind: 'plusminus', match: m[0], label: `"${m[0]}" (write ±)` });
  if (h.dataPlural) for (const m of s.matchAll(DATA_SING_RE)) out.push({ kind: 'data', match: m[0], label: `"${m[0]}" (the document treats data as plural)` });
  for (const num of numeralStarts(s)) out.push({ kind: 'numeral-start', match: num, label: `a sentence starts with "${num}"` });
  for (const sp of sentenceSpans(s)) {
    if (!endsSentence(sp.text)) continue;
    for (const clause of sp.text.split(/;/)) {
      const mean = clause.match(MEAN_RE);
      if (mean && /\d/.test(clause) && !SPREAD_RE.test(clause)) out.push({ kind: 'mean', match: mean[0], label: `"${mean[0]}" without SD, SE or CI` });
    }
  }
  return out;
}

// ---- Wordy phrases -----------------------------------------------------------------------------------------------------
// The concision hits of a text as note items: '"in order to" → "to"', '"it should be noted that" → drop it'.
function wordyNoteItems(hits) {
  return hits.map((h) => `"${tcClip(h.match)}" → ${h.to === '' ? 'drop it' : h.to.startsWith('=') ? h.to.slice(1) : `"${h.to}"`}`);
}

// ---- The beforeWrite hook --------------------------------------------------------------------------------------------
// The lines of an insert that head the text, true per line of text: those with a heading or title style (styled(i)), and
// the first other line when it ends no sentence and more text follows (a title above the text, such as a paper title in
// normal text under an outline's heading).
function insertHeads(text, styled) {
  const lines = tcStr(text).split('\n');
  const out = lines.map((l, i) => !!styled(i));
  const first = lines.findIndex((l, i) => !out[i] && l.trim());
  if (first >= 0 && !endsSentence(lines[first]) && lines.slice(first + 1).some((l) => l.trim())) out[first] = true;
  return out;
}
// Every line of a replace inside one heading or title line of the model before the write, else none.
function replaceHeads(text, snap, region) {
  const m = snap && snap.model;
  const l = m && Array.isArray(m.lines) && Array.isArray(region) && region[0] === region[1] ? m.lines[region[0] - 1] : null;
  return tcStr(text).split('\n').map(() => !!(l && l.heading));
}
const HEAD_STYLES = ['title', 'subtitle', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
// insert_after_line: which lines its style makes headings (an outline: the lines with # marks of the text as sent).
function insertStyled(args) {
  const style = typeof (args && args.style) === 'string' ? args.style.trim().toLowerCase() : '';
  if (style === 'outline') { const raw = tcStr(args.text).split('\n'); return (i) => /^#{1,6}[ \t]+/.test(raw[i] || ''); }
  const key = style ? parseHeading(style) : null;
  return () => HEAD_STYLES.includes(key);
}

// The old and new texts of a write, one part per operation of edit_document: [{ oldText, newText, line, churn, heads }];
// churn: a replacement with old text that the churn measure applies to; heads: true per line of newText that heads the
// text (a heading, a title: the abbreviation check skips them).
function textCheckParts(name, plan, args, snap) {
  const p = plan || {};
  if (name === 'edit_document' && Array.isArray(p.ops)) {
    return p.ops.filter((o) => o.op === 'replace' || o.op === 'insert').map((o) => {
      if (o.op === 'insert') {
        const wants = Array.isArray(o.wants) ? o.wants : [];
        return { oldText: '', newText: tcStr(o.raw), line: Number(o.n) || 0, churn: false, heads: insertHeads(o.raw, (i) => !!wants[i] && wants[i] !== 'NORMAL_TEXT') };
      }
      const newText = tcStr(o.given && o.given.new_text);
      return { oldText: tcStr(o.given && o.given.old_text), newText, line: Array.isArray(o.region) ? o.region[0] : 0, churn: true, heads: replaceHeads(newText, snap, o.region) };
    });
  }
  const { oldText, newText } = writeTexts(name, p, args || {}, snap || {});
  const insert = name === 'insert_after_line';
  const line = insert ? Number(args && args.line) || 0 : Array.isArray(p.region) ? p.region[0] : 0;
  const heads = insert ? insertHeads(newText, insertStyled(args)) : replaceHeads(newText, snap, p.region);
  return [{ oldText: tcStr(oldText), newText: tcStr(newText), line, churn: name === 'replace_text' || name === 'replace_section', heads }];
}

// What the document is like at the start of the turn, once per snapshot: { text, words, metrics, spacing, stats, maxima,
// abbr }.
function textDocProfile(snap) {
  if (!snap) return { text: '', words: 0, metrics: null, spacing: {}, stats: {}, maxima: {}, abbr: abbrDocIndex('') };
  if (!snap.textChecksDoc) {
    const text = tcStr((snap.promptView && snap.promptView.docText) || snap.docText);
    const sample = text.slice(0, STYLE_SAMPLE_CHARS);
    snap.textChecksDoc = {
      text, words: countWords(sample), metrics: textMetrics(sample, 5), spacing: spacingHabits(text), stats: statsHabits(text), maxima: figureMaxima(text),
      abbr: abbrDocIndex(text),
    };
  }
  return snap.textChecksDoc;
}

// The items of b that a does not have (multiset on key): the author's own findings are not noted.
function newFindings(oldList, newList, key) {
  const have = new Map();
  for (const it of oldList) have.set(key(it), (have.get(key(it)) || 0) + 1);
  return newList.filter((it) => {
    const n = have.get(key(it)) || 0;
    if (n > 0) { have.set(key(it), n - 1); return false; }
    return true;
  });
}

// Whether a phrase is (part of) a tell that prose-lint.js reports on the same text: compared as whole words.
const tcWords = (s) => ' ' + textWords(String(s).toLowerCase()).join(' ') + ' ';
const inTells = (tells, phrase) => { const p = tcWords(phrase); return p.trim() !== '' && tells.some((t) => t.includes(p) || p.includes(t)); };

// The note lines, cut to TEXT_NOTE_CHARS in all: a line takes up to TEXT_NOTE_ITEMS items, then "+N more"; when the
// budget runs out a line keeps the items that fit, and lines with none are left out.
function capNoteLines(lines) {
  const out = [];
  let left = TEXT_NOTE_CHARS;
  const render = (l, items, rest) => `${l.head}: ${items.join('; ')}${rest ? `; +${rest} more` : ''}${l.tail || ''}.`;
  for (const l of lines) {
    if (l.text) { if (l.text.length <= left) { out.push(l.text); left -= l.text.length; } continue; }
    const items = l.items.slice(0, TEXT_NOTE_ITEMS);
    let rest = l.items.length - items.length;
    while (items.length) {
      const t = render(l, items, rest);
      if (t.length <= left) { out.push(t); left -= t.length; break; }
      items.pop(); rest++;
    }
  }
  return out;
}

// beforeWrite(name, plan, args, snap) -> null | { notes }. Never refuses.
function textChecks(name, plan, args, snap) {
  if (!TEXT_CHECK_TOOLS.includes(name)) return null;
  const parts = textCheckParts(name, plan, args, snap).filter((p) => p.newText.trim());
  if (!parts.length) return null;
  const doc = textDocProfile(snap);
  const oldAll = parts.map((p) => p.oldText).join('\n\n');
  const newAll = parts.map((p) => p.newText).join('\n\n');
  const tells = proseTells(newAll, null).map((t) => tcWords(t.match));
  const keep = (kind, text) => !textCheckIgnored(kind, text);
  const fresh = (fn) => newFindings(fn(oldAll), fn(newAll), (x) => x.kind + '\u0000' + x.match.toLowerCase());
  const lines = [];
  const list = (head, items, tail) => { if (items.length) lines.push({ head, items, tail }); };

  const drift = parts.filter((p) => p.oldText.trim()).flatMap((p) => meaningDrift(p.oldText, p.newText)).filter((d) => keep('drift', d.pair));
  list('meaning may have shifted', [...new Set(drift.map((d) => d.pair))]);
  const claims = fresh(claimLint).filter((c) => !inTells(tells, c.match) && keep('claims', c.match));
  list('claims', [...new Set(claims.map((c) => c.label))]);
  const stats = fresh((t) => statsLint(t, doc.stats)).filter((x) => keep('statistics', x.match));
  list('statistics', [...new Set(stats.map((x) => x.label))]);
  const oldRefs = new Set(figureRefIssues(oldAll, doc.maxima, doc.words).map((r) => r.text));
  const refs = figureRefIssues(newAll, doc.maxima, doc.words).filter((r) => !oldRefs.has(r.text) && keep('figures', r.text));
  list('not in the document', refs.map((r) => `"${r.text}" (${r.max ? `${TARGET_LABEL[r.kind]} end at ${r.max}` : `no ${TARGET_LABEL[r.kind]}`})`), '; a caption inside an image is not seen');
  const heads = parts.flatMap((p, i) => [...(i ? [false] : []), ...p.heads]); // newAll's lines (an empty one between parts)
  const abbr = abbreviationIssues(newAll, doc.abbr, heads).filter((k) => keep('abbreviations', k));
  list('abbreviations not defined', abbr.map((k) => `"${k}"`), abbr.length ? ` (write the full term at first use: "… (${abbr[0]})")` : '');
  const oldUnits = new Set(unitSpacingIssues(oldAll, doc.spacing).map((u) => u.text));
  const units = unitSpacingIssues(newAll, doc.spacing).filter((u) => !oldUnits.has(u.text) && keep('units', u.text));
  list('unit spacing', [...new Set(units.map((u) => `"${u.text}" (the document: "${u.want}")`))]);

  if (asksFix(turnUserText(snap))) {
    // A translation is the language check's business (src/lang-check.js), not a rewrite.
    const shares = parts.filter((p) => p.churn && p.oldText.trim() && textLang(p.oldText) === textLang(p.newText)).map((p) => churnShare(p.oldText, p.newText)).filter((x) => x != null);
    const top = shares.length ? Math.max(...shares) : 0;
    if (top > CHURN_LIMIT && keep('churn', String(tcPct(top)))) {
      lines.push({ text: `this rewrote ${tcPct(top)}% of the paragraph for a fix request; keep edits minimal unless asked to rewrite.` });
    }
  }
  const neu = textMetrics(newAll);
  const metrics = neu && doc.metrics && neu.lang === doc.metrics.lang
    ? metricsNote(neu, doc.metrics, oldAll.trim() ? textMetrics(oldAll) : null) : '';
  if (metrics && keep('metrics', metrics)) lines.push({ text: metrics });
  const wordy = newFindings(concisionHits(oldAll), concisionHits(newAll), (h) => h.match.toLowerCase())
    .filter((h) => !inTells(tells, h.match) && keep('wordy', h.match));
  list('wordy', [...new Set(wordyNoteItems(wordy))]);

  const notes = capNoteLines(lines);
  return notes.length ? { notes } : null;
}

if (typeof registerTurnHook === 'function') registerTurnHook('beforeWrite', textChecks);
