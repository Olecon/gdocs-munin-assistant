'use strict';
// Module doc-conventions.js: deterministic measurements of the document text for the turn context (no model call):
// - the conventions line (conventionsLine / docConventions): how the document refers to figures and tables, its
//   citation format, number ranges, unit spacing, the Oxford comma, British or American spelling and, in a Russian
//   text, the decimal separator; a convention appears only with at least 2 occurrences and a clear majority;
// - the glossary line (glossaryLine / docGlossary): recurring multi-word terms with their spelling variants
//   ("spin label" / "spin-label") and the abbreviations the text defines ("molecular dynamics (MD)");
// - the hedge and passive counters of the style line (hedgeCount, hedgeRate, isPassive, passiveRate);
// - sectionExpectation(model, line): one line about the section a write goes into (its heading, its first sentence and,
//   for a classic section type, one clause of what that type does), for revise_section and the write path; the type
//   comes from the whole heading (sectionKind) or the enclosing classic section (sectionKindOf);
// - criteriaLine(snap, text): the criteria of a classic section type for a vague improve request on it;
// - textExcerpt(text, max, from): a paragraph cut at sentence boundaries, from its start or its end, for model requests.
// The counters and the extraction are exported for the per-write checks; the results are cached per text, so the
// turn context and the checks of one snapshot measure the text once.
/* global countWords, endsSentence, locateSelection, splitSentences, textLang */
/* exported docConventions, conventionsLine, docGlossary, glossaryLine, hedgeCount, hedgeRate, isPassive, passiveRate,
   sectionKind, sectionKindAt, namedSectionKind, SECTION_HINTS, sectionExpectation, memoByText, CONVENTIONS_SAMPLE_CHARS,
   SECTION_CRITERIA, vagueRequest, criteriaLine, sectionHeadAt, textExcerpt */

// The conventions and the glossary read up to this many characters (regexes only: cheap even on a long document).
const CONVENTIONS_SAMPLE_CHARS = 100000;
// A convention is reported when its most frequent form occurs at least twice and in at least this share of the cases.
const CONVENTION_MAJORITY = 2 / 3;
const GLOSSARY_MIN_COUNT = 3; // a term recurs at least this many times
const GLOSSARY_MAX_TERMS = 8;
const GLOSSARY_MAX_ABBRS = 6;
const GLOSSARY_LINE_CHARS = 200; // about 60 tokens
const SECTION_SAYS_CHARS = 120;

// One cached result per function: recomputed when the text (or the second key, such as the line model) changes.
function memoByText(fn) {
  let key; let key2; let value; let has = false;
  return (text, second) => {
    const t = String(text == null ? '' : text);
    if (!has || t !== key || second !== key2) { key = t; key2 = second; value = fn(t, second); has = true; }
    return value;
  };
}

// The text before a References heading (a reference list would count as citations, terms and units).
function bodyText(text) {
  const s = String(text || '').slice(0, CONVENTIONS_SAMPLE_CHARS);
  const m = /^[ \t]*(?:\d+[.)]?\s*)?(?:references|bibliography|literature cited|works cited|список литературы|литература|библиография|список источников)[ \t]*$/imu.exec(s);
  return m ? s.slice(0, m.index) : s;
}

// The key with the clear majority of counts ({ key: n }), or null.
function majority(counts) {
  const entries = Object.entries(counts).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return null;
  const total = entries.reduce((a, [, n]) => a + n, 0);
  const [key, n] = entries[0];
  return n >= 2 && n / total >= CONVENTION_MAJORITY ? key : null;
}
const countRe = (s, re) => (s.match(re) || []).length;

// ---- Conventions ----------------------------------------------------------------------------------------------
// Figure and table pointers, keyed by form; a pointer at the start of a line is a caption and is not counted.
const POINTER_FORMS = {
  figures: [
    ['Figure', /(?<!^|\n)(?<![\p{L}])(Figures?)[ \u00a0]+\d/gu],
    ['Fig.', /(?<!^|\n)(?<![\p{L}])(Figs?\.)[ \u00a0]*\d/giu],
    ['рис.', /(?<!^|\n)(?<![\p{L}])(рис\.)[ \u00a0]*\d/giu],
    ['рисунок', /(?<!^|\n)(?<![\p{L}])(рисун\p{L}*)[ \u00a0]+\d/giu],
  ],
  tables: [
    ['Table', /(?<!^|\n)(?<![\p{L}])(Tables?)[ \u00a0]+\d/gu],
    ['Tab.', /(?<!^|\n)(?<![\p{L}])(Tabs?\.)[ \u00a0]*\d/giu],
    ['табл.', /(?<!^|\n)(?<![\p{L}])(табл\.)[ \u00a0]*\d/giu],
    ['таблица', /(?<!^|\n)(?<![\p{L}])(таблиц\p{L}*)[ \u00a0]+\d/giu],
  ],
};
// The pointer form of figures or tables with its example ("Fig. 2", "(Fig. 2)", "рис. 2"), or null.
function pointerForm(s, kind) {
  const counts = {};
  const seen = {};
  for (const [form, re] of POINTER_FORMS[kind]) {
    for (const m of s.matchAll(re)) {
      counts[form] = (counts[form] || 0) + 1;
      const st = seen[form] || (seen[form] = { paren: 0, cases: {} });
      if (s[m.index - 1] === '(') st.paren++;
      const word = /^(рисун|таблиц)/i.test(form) ? form : m[1].replace(/s(?=\.?$)/, '');
      st.cases[word] = (st.cases[word] || 0) + 1;
    }
  }
  const form = majority(counts);
  if (!form) return null;
  const st = seen[form];
  const word = Object.entries(st.cases).sort((a, b) => b[1] - a[1])[0][0];
  const example = `${word} ${kind === 'figures' ? 2 : 1}`;
  return st.paren / counts[form] >= CONVENTION_MAJORITY ? `(${example})` : example;
}

// Citations: numeric in brackets, author-year with or without the comma, Unicode superscript digits after a word, DOIs
// in brackets ("[10.1021/…]", "[doi:10.…]", several in one bracket).
const CITE_NUMERIC_RE = /\[\d{1,3}(?:\s*[,–-]\s*\d{1,3})*\]/g;
const CITE_AUTHOR_RE = /\((?:see |e\.g\.,? |cf\. |см\. )?\p{Lu}[\p{L}'’-]+(?:\s+(?:et al\.|and \p{Lu}[\p{L}'’-]+|& \p{Lu}[\p{L}'’-]+|и др\.|и \p{Lu}[\p{L}'’-]+))?(,?)\s+(?:1[89]|20)\d{2}[a-z]?(?:[;,][^()\n]{0,80})?\)/gu;
const CITE_SUPER_RE = /[\p{L})][¹²³⁴⁵⁶⁷⁸⁹⁰]+(?:[,–-][¹²³⁴⁵⁶⁷⁸⁹⁰]+)*/gu;
const CITE_DOI_ITEM = '(?:doi:\\s*)?10\\.\\d{4,9}/[^\\]\\s,;]+';
const CITE_DOI_BRACKET_RE = new RegExp(`\\[${CITE_DOI_ITEM}(?:\\s*[,;]\\s*${CITE_DOI_ITEM})*\\]`, 'giu');
function citationForm(s) {
  const counts = { numeric: countRe(s, CITE_NUMERIC_RE), comma: 0, plain: 0, superscript: countRe(s, CITE_SUPER_RE), doi: countRe(s, CITE_DOI_BRACKET_RE) };
  for (const m of s.matchAll(CITE_AUTHOR_RE)) counts[m[1] ? 'comma' : 'plain']++;
  // the author-year forms compete with the other formats together, then with each other
  const author = counts.comma + counts.plain;
  const kind = majority({ numeric: counts.numeric, author, superscript: counts.superscript, doi: counts.doi });
  if (kind === 'numeric') return '[n]';
  if (kind === 'superscript') return 'superscript numbers';
  if (kind === 'doi') return '[doi]';
  if (kind !== 'author') return null;
  const form = majority({ comma: counts.comma, plain: counts.plain });
  return form === 'comma' ? '(Author, Year)' : form === 'plain' ? '(Author Year)' : null;
}

// Number ranges: en dash (unspaced or spaced), hyphen, "to" / "от … до". Dates (2020-01-05), identifiers (COVID-19)
// section numbers and citation ranges in brackets ([4–6]) are not ranges.
const NUM = '\\d+(?:[.,]\\d+)?';
const RANGE_EN_RE = new RegExp(`(?<![\\p{L}\\d.,/[-])${NUM}–${NUM}(?![\\d\\p{L}–-])`, 'gu');
const RANGE_EN_SPACED_RE = new RegExp(`(?<![\\p{L}\\d.,/[-])${NUM} – ${NUM}(?![\\d\\p{L}–-])`, 'gu');
const RANGE_HYPHEN_RE = new RegExp(`(?<![\\p{L}\\d.,/[-])${NUM}-${NUM}(?![\\d\\p{L}–-])`, 'gu');
const RANGE_TO_RE = new RegExp(`(?<![\\p{L}\\d.,])${NUM}(?: ?[%°\\p{L}]{0,4})? to ${NUM}(?![\\d])`, 'gu');
const RANGE_OT_RE = new RegExp(`(?<![\\p{L}])от ${NUM}(?: ?[%°\\p{L}]{0,4})? до ${NUM}`, 'giu');
function rangeForm(s) {
  const form = majority({
    '5–10': countRe(s, RANGE_EN_RE), '5 – 10': countRe(s, RANGE_EN_SPACED_RE), '5-10': countRe(s, RANGE_HYPHEN_RE),
    '"5 to 10"': countRe(s, RANGE_TO_RE), '"от 5 до 10"': countRe(s, RANGE_OT_RE),
  });
  return form;
}

// Units after a number: with a space (a no-break or thin space counts as a space) or without. Single-letter and
// ambiguous units (m, M, L, K, s in Russian "с", "г" after a year, "В") are left out.
const CONV_UNITS = [
  'mM', 'µM', 'μM', 'nM', 'pM', 'mg', 'µg', 'μg', 'ng', 'kg', 'g', 'mL', 'ml', 'µL', 'μL', 'µl', 'μl', 'nm', 'µm', 'μm',
  'mm', 'cm', 'km', 'Å', 'ms', 'µs', 'μs', 'ns', 'ps', 'fs', 'min', 'h', 'Hz', 'kHz', 'MHz', 'GHz', 'kDa', 'Da', 'kJ',
  'kcal', 'eV', 'meV', 'mol', 'mmol', 'µmol', 'μmol', 'mV', 'kV', 'mW', 'kW', 'Pa', 'kPa', 'MPa', 'mbar', 'bar', 'rpm',
  'GB', 'MB', 'kb', 'bp', 'dB', 'ppm',
  'мМ', 'мкМ', 'нМ', 'мг', 'мкг', 'кг', 'мл', 'мкл', 'нм', 'мкм', 'мм', 'см', 'км', 'мин', 'мс', 'нс', 'Гц', 'кГц',
  'МГц', 'кДа', 'кДж', 'ккал', 'эВ', 'моль', 'ммоль', 'мВ', 'кВ', 'Вт', 'кВт', 'Па', 'кПа', 'МПа', 'бар',
].sort((a, b) => b.length - a.length);
const UNIT_RE = new RegExp(`(?<![\\p{L}\\d.,]|(?:Figs?|Figures?|Tables?|рис|табл)\\.? ?)\\d+(?:[.,]\\d+)?([ \\u00a0\\u202f]?)(?:${CONV_UNITS.join('|')})(?![\\p{L}\\d])`, 'gu');
const DEGREE_RE = /(?<![\p{L}\d.,])\d+(?:[.,]\d+)?([ \u00a0\u202f]?)°\s?[CС]/gu;
const PERCENT_RE = /(?<![\p{L}\d.,])\d+(?:[.,]\d+)?([ \u00a0\u202f]?)%/gu;
// The example of the majority spacing ("5 mM" or "5mM") taken from the text, or null.
function spacingForm(s, re) {
  const ex = { spaced: null, tight: null };
  const counts = { spaced: 0, tight: 0 };
  for (const m of s.matchAll(re)) {
    const k = m[1] ? 'spaced' : 'tight';
    counts[k]++;
    if (!ex[k]) ex[k] = m[0].replace(/[\u00a0\u202f]/g, ' ');
  }
  const k = majority(counts);
  return k ? `"${ex[k]}"` : null;
}

// The Oxford comma in English lists of short items: "A, B, and C" against "A, B and C" (the first item after a
// lowercase word, so a sentence opener such as "However, A and B" is not a list).
const OXFORD_RE = /(?<=\p{Ll} )\p{L}[\p{L}-]*(?: \p{L}[\p{L}-]*){0,2}, \p{L}[\p{L}-]*(?: \p{L}[\p{L}-]*){0,2}, (?:and|or) \p{L}/gu;
const NO_OXFORD_RE = /(?<=\p{Ll} )\p{L}[\p{L}-]*(?: \p{L}[\p{L}-]*){0,2}, \p{L}[\p{L}-]*(?: \p{L}[\p{L}-]*){0,2} (?:and|or) \p{L}/gu;
// a list item does not start with a clause word ("…, which was heated and dried")
const CLAUSE_WORD_RE = /, (?:which|who|whom|whose|that|when|where|while|although|because|but|so|as|if|we|it|they|this|these|there|the)\b[^,]*(?: and| or) \p{L}$/u;
function oxfordForm(s) {
  const yes = [...s.matchAll(OXFORD_RE)].filter((m) => !CLAUSE_WORD_RE.test(m[0])).length;
  const no = [...s.matchAll(NO_OXFORD_RE)].filter((m) => !CLAUSE_WORD_RE.test(m[0])).length;
  const k = majority({ yes, no });
  return k === 'yes' ? 'Oxford comma' : k === 'no' ? 'no Oxford comma' : null;
}

// British and American spellings: word pairs, plus -ise/-ize verbs counted apart (Oxford spelling is British with -ize).
const SPELLING_PAIRS = [
  ['colour', 'color'], ['colours', 'colors'], ['coloured', 'colored'], ['behaviour', 'behavior'], ['behaviours', 'behaviors'],
  ['behavioural', 'behavioral'], ['favour', 'favor'], ['favourable', 'favorable'], ['labour', 'labor'], ['neighbour', 'neighbor'],
  ['neighbouring', 'neighboring'], ['flavour', 'flavor'], ['vapour', 'vapor'], ['tumour', 'tumor'], ['tumours', 'tumors'], ['honour', 'honor'],
  ['centre', 'center'], ['centres', 'centers'], ['centred', 'centered'], ['fibre', 'fiber'], ['fibres', 'fibers'], ['litre', 'liter'],
  ['litres', 'liters'], ['millilitre', 'milliliter'], ['millilitres', 'milliliters'], ['theatre', 'theater'],
  ['modelling', 'modeling'], ['modelled', 'modeled'], ['labelling', 'labeling'], ['labelled', 'labeled'], ['signalling', 'signaling'],
  ['travelled', 'traveled'], ['cancelled', 'canceled'], ['fuelled', 'fueled'], ['channelling', 'channeling'],
  ['analyse', 'analyze'], ['analysed', 'analyzed'], ['analysing', 'analyzing'], ['catalyse', 'catalyze'], ['catalysed', 'catalyzed'],
  ['hydrolyse', 'hydrolyze'], ['hydrolysed', 'hydrolyzed'], ['dialyse', 'dialyze'], ['dialysed', 'dialyzed'],
  ['grey', 'gray'], ['aluminium', 'aluminum'], ['haemoglobin', 'hemoglobin'], ['anaemia', 'anemia'], ['oedema', 'edema'],
  ['oestrogen', 'estrogen'], ['foetal', 'fetal'], ['paediatric', 'pediatric'], ['leukaemia', 'leukemia'], ['haem', 'heme'],
  ['defence', 'defense'], ['catalogue', 'catalog'], ['analogue', 'analog'], ['analogues', 'analogs'], ['ageing', 'aging'],
  ['judgement', 'judgment'], ['artefact', 'artifact'], ['artefacts', 'artifacts'], ['sceptical', 'skeptical'],
];
const SPELL_BRIT = new Set(SPELLING_PAIRS.map((p) => p[0]));
const SPELL_AMER = new Set(SPELLING_PAIRS.map((p) => p[1]));
const ISE_STEMS = ['optimi', 'minimi', 'maximi', 'normali', 'characteri', 'organi', 'recogni', 'utili', 'stabili', 'generali',
  'visuali', 'summari', 'parameteri', 'categori', 'standardi', 'synthesi', 'polymeri', 'crystalli', 'ioni', 'neutrali',
  'immobili', 'locali', 'reali', 'prioriti', 'emphasi', 'hypothesi', 'randomi', 'solubili', 'homogeni', 'lineari'];
const ISE_RE = new RegExp(`\\b(?:${ISE_STEMS.join('|')})(s|z)(?:e|es|ed|ing|ation|ations|er|ers)\\b`, 'giu');
function spellingForm(s) {
  let brit = 0; let amer = 0;
  for (const m of s.matchAll(/\b[a-z]+\b/gi)) {
    const w = m[0].toLowerCase();
    if (SPELL_BRIT.has(w)) brit++;
    else if (SPELL_AMER.has(w)) amer++;
  }
  let ise = 0; let ize = 0;
  for (const m of s.matchAll(ISE_RE)) { if (m[1].toLowerCase() === 's') ise++; else ize++; }
  const variant = majority({ British: brit, American: amer });
  const suffix = majority({ ise, ize });
  if (variant === 'British') return suffix === 'ize' ? 'British spelling with -ize' : 'British spelling';
  if (variant === 'American') return 'American spelling';
  if (brit || amer) return null; // mixed spellings: no convention to state
  return suffix === 'ise' ? 'British spelling (-ise)' : suffix === 'ize' ? '-ize spelling' : null;
}

// The decimal separator of a Russian text: "3,5" against "3.5" (one separator, one or two digits after it; section
// and figure numbers, dates and versions are not decimals).
const DECIMAL_RE = /(?<![\p{L}\d.,/]|(?:рис|табл|разд|гл|п|ур)\. ?|(?:раздел|пункт|section|figure|table) )\d+([.,])\d{1,2}(?![\d,/]|\.\d)/giu;
function decimalForm(s) {
  const counts = { comma: 0, point: 0 };
  for (const line of s.split('\n')) {
    if (/^\s*\d+(?:\.\d+)+\.?\s/.test(line)) continue; // a numbered heading
    for (const m of line.matchAll(DECIMAL_RE)) counts[m[1] === ',' ? 'comma' : 'point']++;
  }
  const k = majority(counts);
  return k ? `decimal ${k}` : null;
}

// The detected conventions of a text: { figures, tables, citations, ranges, units, degrees, percent, oxford, spelling,
// decimal } (null where nothing clear was found).
const docConventions = memoByText((text) => {
  const s = bodyText(text);
  const lang = textLang(s);
  return {
    figures: pointerForm(s, 'figures'),
    tables: pointerForm(s, 'tables'),
    citations: citationForm(s),
    ranges: rangeForm(s),
    units: spacingForm(s, UNIT_RE),
    degrees: spacingForm(s, DEGREE_RE),
    percent: spacingForm(s, PERCENT_RE),
    oxford: lang === 'en' ? oxfordForm(s) : null,
    spelling: lang === 'en' ? spellingForm(s) : null,
    decimal: lang === 'ru' ? decimalForm(s) : null,
  };
});

// The conventions line of the turn context, or '' when nothing was detected. Sent where the style line is (the caller
// checks that the document is long enough to measure).
function conventionsLine(snap) {
  if (!snap || snap.docText == null) return '';
  const c = docConventions(snap.docText);
  const parts = [];
  if (c.figures) parts.push(`figures ${quoteForm(c.figures)}`);
  if (c.tables) parts.push(`tables ${quoteForm(c.tables)}`);
  if (c.citations) parts.push(`citations ${c.citations}`);
  if (c.ranges) parts.push(`ranges ${c.ranges}`);
  const units = [c.units, c.degrees, c.percent].filter(Boolean);
  if (units.length) parts.push(`units ${units.join(', ')}`);
  for (const k of ['oxford', 'spelling', 'decimal']) if (c[k]) parts.push(c[k]);
  return parts.length ? `Conventions: ${parts.join('; ')}.` : '';
}
const quoteForm = (f) => `"${f}"`;

// ---- Glossary -----------------------------------------------------------------------------------------------------
const STOP_WORDS = new Set((
  'a an the of in on at to for with and or nor by from as is are was were be been being this that these those we our us ' +
  'it its which who whom whose than then not no also can could may might will would should must shall do does did done ' +
  'has have had there here such each other both all any some more most less least very only into onto over under about ' +
  'after before between during within without through via per et al i e g eg ie vs if but so when where while how what ' +
  'they them their he she his her you your one two three first second new used using use based however thus therefore ' +
  'и в во на с со по для что это как из к ко о об от до не ни а но или при так же мы нас наш его её ее их он она они ' +
  'был была было были быть есть этот эта это эти того том тем также то же ли бы уже ещё еще все всё всех весь между ' +
  'под над перед после через без около который которая которое которые которых чем где когда если чтобы может могут'
).split(/\s+/));
// a word of a term: letters (digits inside allowed: "T4 lysozyme"), joined by hyphens or en dashes
const TERM_WORD_RE = /[\p{L}\p{N}]+(?:[-‐‑–'’][\p{L}\p{N}]+)*/gu;
// chunks that a term never crosses: sentence and clause punctuation, brackets, quotes, line breaks, spaced dashes
const CHUNK_SPLIT_RE = /[.,;:!?()[\]{}"«»“”„\n\t\v]|\s[—–-]\s|—/u;
const termParts = (w) => w.split(/[-‐‑–]/u).filter(Boolean);
// English plural of the last word stripped ("labels" → "label"); a word ending in ss, us, is or ics stays.
const singular = (w) => (/^[a-z]{4,}s$/.test(w) && !/(ss|us|is|ics)$/.test(w) ? (/ies$/.test(w) ? w.slice(0, -3) + 'y' : w.slice(0, -1)) : w);
// The surface of a term without its case and plural, keeping its separators: one variant per distinct spelling.
function variantKey(surface) {
  const s = surface.toLowerCase().replace(/\s+/g, ' ');
  const m = /^(.*?)([\p{L}\p{N}]+)$/u.exec(s);
  return m ? m[1] + singular(m[2]) : s;
}
// The grouping key: lowercase parts joined by spaces, the last one singular ("Spin-labels" → "spin label").
function termKey(parts) {
  const p = parts.map((x) => x.toLowerCase().replace(/['’]/g, ''));
  p[p.length - 1] = singular(p[p.length - 1]);
  return p.join(' ');
}

// Abbreviations defined in the text: "Expansion (ABBR)" and "ABBR (expansion)", the initials of the expansion's parts
// matching the abbreviation's letters in order (the first letter first).
const ABBR_TOKEN = '[A-ZА-ЯЁ][A-Za-zА-Яа-яЁё0-9]*[A-ZА-ЯЁ0-9][A-Za-zА-Яа-яЁё0-9]*';
const ABBR_AFTER_RE = new RegExp(`\\((${ABBR_TOKEN})\\)`, 'gu');
const ABBR_BEFORE_RE = new RegExp(`(?<![\\p{L}\\p{N}])(${ABBR_TOKEN}) \\(([^()\\n]{3,80})\\)`, 'gu');
function initialsMatch(abbr, words) {
  const letters = abbr.replace(/s$/, '').toLowerCase().replace(/[^a-zа-яё]/g, '');
  if (letters.length < 2 || !words.length || words.length > letters.length + 2) return false;
  if (STOP_WORDS.has(words[0].toLowerCase()) || STOP_WORDS.has(words[words.length - 1].toLowerCase())) return false;
  if (words[0][0].toLowerCase() !== letters[0]) return false;
  // every letter in order inside the expansion, each part (hyphen pieces too) giving at least its initial
  const flat = words.join(' ').toLowerCase();
  let at = 0;
  for (const ch of letters) { at = flat.indexOf(ch, at); if (at < 0) return false; at++; }
  const parts = words.flatMap((w) => termParts(w)).filter((w) => !STOP_WORDS.has(w.toLowerCase()));
  return parts.length <= letters.length + 1;
}
function abbreviations(s) {
  const out = new Map();
  for (const m of s.matchAll(ABBR_AFTER_RE)) {
    const abbr = m[1].replace(/(?<=[A-ZА-ЯЁ])s$/, '');
    if (out.has(abbr)) continue;
    const before = s.slice(Math.max(0, m.index - 160), m.index).split(CHUNK_SPLIT_RE).pop();
    const words = before.match(TERM_WORD_RE) || [];
    for (let k = 1; k <= Math.min(words.length, abbr.length + 2); k++) {
      const cand = words.slice(-k);
      if (initialsMatch(abbr, cand)) { out.set(abbr, cand.join(' ')); break; }
    }
  }
  for (const m of s.matchAll(ABBR_BEFORE_RE)) {
    const abbr = m[1].replace(/(?<=[A-ZА-ЯЁ])s$/, '');
    if (out.has(abbr)) continue;
    const words = m[2].trim().match(TERM_WORD_RE) || [];
    if (words.join(' ').length >= m[2].trim().length - 2 && initialsMatch(abbr, words)) out.set(abbr, words.join(' '));
  }
  // a capital that only opens the sentence goes ("Root mean square deviation"); a name keeps it ("Monte Carlo")
  const lowerFirst = (e) => (/^\p{Lu}\p{Ll}*(?:[-–]\p{Ll}+)*(?: [\p{Ll}\p{N}][^ ]*)*$/u.test(e) && / /.test(e) ? e[0].toLowerCase() + e.slice(1) : e);
  return [...out].map(([abbr, expansion]) => ({ abbr, expansion: lowerFirst(expansion) }));
}

// The recurring terms and the defined abbreviations of a text:
// { terms: [{ canonical, variants: [surface], count }], abbreviations: [{ abbr, expansion }] }. A term is a run of
// 1–3 words with 2–4 parts ("spin-label" is one word of two parts), no stop word in it, at least GLOSSARY_MIN_COUNT
// times in the text; its spellings are grouped without case, hyphens and the English plural; canonical is the most
// frequent spelling, variants the others (most frequent first). A term inside a longer term of nearly the same count
// is left out, and so is the expansion of an abbreviation. Terms with variants come first, then by count.
const docGlossary = memoByText((text) => {
  const s = bodyText(text);
  const groups = new Map(); // key -> { count, forms: Map(variantKey -> { n, surfaces: Map(surface -> n) }) }
  for (const chunk of s.split(CHUNK_SPLIT_RE)) {
    const words = chunk.match(TERM_WORD_RE);
    if (!words || words.length < 1) continue;
    for (let i = 0; i < words.length; i++) {
      let parts = [];
      for (let n = 1; n <= 3 && i + n <= words.length; n++) {
        const w = words[i + n - 1];
        if (STOP_WORDS.has(w.toLowerCase()) || /^\p{N}+$/u.test(w) || w.length < 2) break;
        parts = parts.concat(termParts(w));
        if (parts.length > 4) break;
        if (parts.length < 2) continue;
        if (parts.some((p) => STOP_WORDS.has(p.toLowerCase()) || /^\p{N}+$/u.test(p))) continue;
        // terms are noun phrases: an adverb or a past participle at either end ("described previously") is not one
        if (/(?:ly|ed)$/i.test(parts[0]) || /(?:ly|ed)$/i.test(parts[parts.length - 1])) continue;
        const surface = words.slice(i, i + n).join(' ');
        const key = termKey(parts);
        const g = groups.get(key) || { count: 0, forms: new Map() };
        g.count++;
        const vk = variantKey(surface);
        const f = g.forms.get(vk) || { n: 0, surfaces: new Map() };
        f.n++;
        const sing = surface.replace(/[\p{L}\p{N}]+$/u, (w) => (w === w.toLowerCase() ? singular(w) : w));
        f.surfaces.set(sing, (f.surfaces.get(sing) || 0) + 1);
        g.forms.set(vk, f);
        groups.set(key, g);
      }
    }
  }
  const abbrs = abbreviations(s);
  const expansions = new Set(abbrs.map((a) => termKey(termPartsOf(a.expansion))));
  let terms = [...groups].filter(([, g]) => g.count >= GLOSSARY_MIN_COUNT).map(([key, g]) => {
    const forms = [...g.forms.values()].sort((a, b) => b.n - a.n);
    // the shown spelling of a form: its most frequent surface, in lower case unless it is always capitalised
    const shown = (f) => {
      const [surface] = [...f.surfaces].sort((a, b) => b[1] - a[1])[0];
      const lowerSeen = [...f.surfaces.keys()].some((x) => x === x.toLowerCase());
      return lowerSeen ? surface.toLowerCase() : surface;
    };
    return { key, canonical: shown(forms[0]), variants: forms.slice(1).map(shown), count: g.count };
  });
  const keys = terms.map((t) => t.key);
  terms = terms.filter((t) => !expansions.has(t.key) &&
    !terms.some((o) => o !== t && o.key.length > t.key.length && ` ${o.key} `.includes(` ${t.key} `) && o.count >= 0.75 * t.count));
  terms.sort((a, b) => (b.variants.length > 0) - (a.variants.length > 0) || b.count - a.count || keys.indexOf(a.key) - keys.indexOf(b.key));
  return {
    terms: terms.slice(0, GLOSSARY_MAX_TERMS).map(({ canonical, variants, count }) => ({ canonical, variants, count })),
    abbreviations: abbrs.slice(0, GLOSSARY_MAX_ABBRS),
  };
});
const termPartsOf = (expansion) => (expansion.match(TERM_WORD_RE) || []).flatMap((w) => termParts(w));

// The glossary line of the turn context, or '': the terms written in more than one way, then the abbreviations, as many
// as fit GLOSSARY_LINE_CHARS. Terms with one spelling stay out: a frequent word pair is not always a term (and in a
// Russian text the case endings make most pairs look rare), and the model sees the text anyway.
function glossaryLine(snap) {
  if (!snap || snap.docText == null) return '';
  const g = docGlossary(snap.docText);
  const items = [
    ...g.terms.filter((t) => t.variants.length).map((t) => `${t.canonical} (also ${t.variants.slice(0, 2).join(', ')})`),
    ...g.abbreviations.map((a) => `${a.abbr} = ${a.expansion}`),
  ];
  const kept = [];
  let len = 'Terms: .'.length;
  for (const it of items) {
    if (len + it.length + 2 > GLOSSARY_LINE_CHARS) continue;
    kept.push(it); len += it.length + 2;
  }
  return kept.length ? `Terms: ${kept.join('; ')}.` : '';
}

// ---- Hedges and the passive voice ------------------------------------------------------------------------------
// Hedge words (English and Russian). "may" counts only in lower case (the month is capitalised).
const HEDGE_EN_RE = /\b(?:may|might|could|possibly|perhaps|probably|presumably|potentially|apparently|likely|unlikely|suggests?|suggested|suggesting|appears?|appeared|seems?|seemed|tends?|tended)\b/g;
const HEDGE_RU_RE = /(?<![\p{L}-])(?:возможно|по-видимому|видимо|по всей видимости|вероятно|вероятнее всего|скорее всего|предположительно|может|могут|могло|могла|мог|могли|кажется|по-моему|похоже|судя по всему|предполагает|предполагают|указывает на)(?![\p{L}-])/giu;
const hedgeCount = (text) => countRe(String(text || ''), HEDGE_EN_RE) + countRe(String(text || ''), HEDGE_RU_RE);
// Hedges per 100 words (one decimal), or null for a text without words.
function hedgeRate(text) {
  const words = countWords(text);
  return words ? Math.round((hedgeCount(text) * 1000) / words) / 10 : null;
}

// An English passive: a form of "be" (an adverb between allowed), then a past participle (a regular -ed word or a
// common irregular one). Adjectives such as "is interested" count too: a rough rate, not a grammar check.
const IRREGULAR_PARTICIPLES = 'done made taken given shown seen found known written chosen drawn grown held kept left lost built bought brought ' +
  'caught taught thought set put cut sent spent told sold paid laid led fed hidden broken spoken frozen driven risen eaten forgotten begun ' +
  'worn torn born shaken mistaken undertaken overcome withdrawn understood undergone run read said heard meant felt won struck split spread ' +
  'shut hit bound ground wound sought fought dug hung stuck thrown blown flown proven sewn';
const PASSIVE_RE = new RegExp(`\\b(?:am|is|are|was|were|be|been|being)\\s+(?:(?:not|also|then|further|often|usually|first|now|thus|therefore|always|never|generally|typically|[a-z]+ly)\\s+)?(?:[a-z]+[^e\\s]ed|(?:${IRREGULAR_PARTICIPLES.split(' ').join('|')}))\\b`, 'i');
const isPassive = (sentence) => PASSIVE_RE.test(String(sentence || ''));
// The share of English sentences with a passive (percent, whole number), or null: a Russian text (the reflexive -ся
// verbs and the short participles are too ambiguous to count) or a text without sentences.
function passiveRate(text) {
  const s = String(text || '');
  if (textLang(s) === 'ru') return null;
  const sentences = splitSentences(s, 'en').filter(endsSentence);
  if (!sentences.length) return null;
  return Math.round((sentences.filter(isPassive).length * 100) / sentences.length);
}

// ---- Section expectations -------------------------------------------------------------------------------------------
// Classic section types by the WHOLE heading (English and Russian), so a topical heading that only mentions the word
// ("Existing approaches and their limitations", "Results of earlier studies") is not that section. The heading is
// compared without its number ("2.1", "II.", "A.", "Chapter 2.", "Глава 2.") and a final colon or period; the first
// match wins, so "Results and discussion" is results.
const SECTION_KIND_RES = [
  ['data', /^(?:(?:data|code|software)(?: and (?:data|code|software|materials))? (?:availability|accessibility)(?: statement)?|availability of (?:data|code|software)(?: and (?:data|code|software|materials))?|доступность (?:данных|кода)(?: и (?:данных|кода|материалов))?)$/u],
  ['limitations', /^(?:(?:study|main|key|potential) )?(?:strengths and )?limitations?(?: of (?:the|this|our) (?:study|work|analysis|approach|method|review))?(?: and (?:strengths|future (?:work|directions|research)|outlook|perspectives|uncertainty|uncertainties))?$|^ограничения(?: (?:исследования|работы|метода|подхода))?$/u],
  ['abstract', /^(?:abstract|summary|executive summary|plain language summary|lay summary|аннотация|реферат|резюме)$/u],
  ['introduction', /^(?:(?:general )?introduction(?: and (?:background|motivation|related work|literature review|objectives))?|background(?: and (?:motivation|rationale|significance|objectives|aims?))?|введение|актуальность(?: (?:темы|исследования|работы|проблемы))?)$/u],
  ['methods', /^(?:methods?|methodology|materials|experimental(?: (?:section|part|procedures?|details|methods|setup|design))?|(?:materials|patients|subjects|participants|data|theory) and methods|methods and (?:materials|data|theory)|(?:computational|simulation|statistical|theoretical|numerical|research|study) (?:methods?|methodology|details|procedures?|setup|design)|study design(?: and methods)?|procedures?|материалы? и методы(?: исследования)?|методы(?: и материалы| исследования)?|методика(?: эксперимента| исследования)?|методология(?: исследования)?|экспериментальная часть|объекты и методы(?: исследования)?|(?:вычислительные|экспериментальные|расчетные) методы)$/u],
  ['results', /^(?:results?|findings|main (?:results|findings)|key findings|experimental results|results and (?:discussion|analysis)|результаты(?: исследования| и (?:их )?обсуждение)?)$/u],
  ['discussion', /^(?:(?:general )?discussion(?: and (?:conclusions?|outlook|implications|future work))?|conclusions?(?: and (?:outlook|future work|perspectives|recommendations))?|concluding remarks|summary and (?:conclusions?|outlook|discussion)|обсуждение(?: результатов)?|заключение(?: и выводы)?|(?:основные )?выводы)$/u],
];
// The heading as the patterns read it: lower case, ё as е, without its number and a final colon or period.
const headingCore = (heading) => String(heading || '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/ё/g, 'е')
  .replace(/^(?:(?:chapter|section|part|глава|раздел|часть) )?(?:\d+(?:\.\d+)*[.:)]?|[ivxlc]+[.)]|[a-zа-я][.)])\s+/u, '')
  .replace(/\s*[.:]$/u, '');
// The classic type of a heading by its own text, or null.
const sectionKind = (heading) => { const t = headingCore(heading); return (SECTION_KIND_RES.find(([, re]) => re.test(t)) || [null])[0]; };
// The type of the section headed by line h of a line model: its own, else that of the nearest enclosing heading that has
// one (a subsection of the Introduction is introduction text); null when neither tells. A Summary inside a classic
// section sums that section up and takes its type, not the abstract's.
function sectionKindOf(model, h) {
  const own = sectionKind(h.text);
  if (own && own !== 'abstract') return own;
  const lines = model && Array.isArray(model.lines) ? model.lines : [];
  let level = h.heading;
  for (let n = h.line - 1; n >= 1 && level > 1; n--) {
    const l = lines[n - 1];
    if (!l || !l.heading || l.cell || !String(l.text).trim() || l.heading >= level) continue;
    level = l.heading;
    const k = sectionKind(l.text);
    if (k) return k;
  }
  return own;
}
// The type of the section that holds line n of a line model (sectionKindOf of the heading above it), or null.
function sectionKindAt(model, n) {
  const h = sectionHeadAt(model, n);
  return h ? sectionKindOf(model, h) : null;
}
// A classic type the words of a request name ("improve the methods", "улучши введение"): a keyword anywhere, unlike a
// heading; the first match wins.
const SECTION_WORD_RES = [
  ['data', /\b(data|code) (and (data|code) )?availability\b|\bavailability of (data|code)\b|доступност\p{L}* данных|данные доступны/iu],
  ['limitations', /\blimitations?\b|ограничени/iu],
  ['abstract', /\b(abstract|summary)\b|аннотац|реферат|резюме/iu],
  ['introduction', /\b(introduction|background)\b|введение|актуальност/iu],
  ['methods', /\b(methods?|methodology|materials|experimental|procedures?)\b|метод|материал|экспериментальн/iu],
  ['results', /\b(results?|findings)\b|результат/iu],
  ['discussion', /\b(discussion|conclusions?)\b|обсуждени|заключени|вывод/iu],
];
const namedSectionKind = (text) => (SECTION_WORD_RES.find(([, re]) => re.test(String(text || ''))) || [null])[0];
// One clause per classic type: the short form of revise_section's section prompts (REVISE_SECTION_PROMPTS).
const SECTION_HINTS = {
  abstract: 'An abstract stands alone: problem, approach, main result with its number, meaning; no citations',
  introduction: 'An introduction moves from what is known to the gap to the aim',
  methods: 'Methods use the past tense and enough detail to repeat the work; no results',
  results: 'Results lead with each finding and its number, the figure pointer after it; no interpretation',
  discussion: 'A discussion interprets and compares with the cited work; claims as strong as written, no new results',
  limitations: 'Limitations name each limit and its likely effect, without apology',
  data: 'A data availability statement says where the data and code are and how to get them',
};
const sectionClip = (t, max) => { const s = String(t).replace(/\s+/g, ' ').trim(); return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s; };

// ---- Excerpts for model requests --------------------------------------------------------------------------------------
// A paragraph cut for a model request or a note: whole sentences from its start (from 'start'), its end ('end') or both
// ('both': half the room each), with EXCERPT_GAP where text was left out. A paragraph cut mid-sentence reads as one
// that stops mid-thought (the connectivity judge blamed the text for it); a sentence longer than the room is cut at a
// word, keeping its start (at the end: its end). The text whole when it fits in max characters.
const EXCERPT_GAP = '[…]';
// The whole sentences from the front of list that fit in room characters, joined by spaces.
function fitSentences(list, room) {
  const out = [];
  let len = -1;
  for (const t of list) { if (len + 1 + t.length > room) break; out.push(t); len += 1 + t.length; }
  return out;
}
// The start (end: the end) of one sentence at a word boundary, at most room characters.
function cutAtWord(t, room, end) {
  if (t.length <= room) return t;
  if (end) { const cut = t.slice(t.length - room); const sp = cut.indexOf(' '); return sp >= 0 && sp < cut.length - 1 ? cut.slice(sp + 1) : cut; }
  const cut = t.slice(0, room + 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > 0 ? cut.slice(0, sp) : cut.slice(0, room)).replace(/[\s,;:—–-]+$/u, '');
}
function textExcerpt(text, max, from = 'start') {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const sents = splitSentences(s);
  const head = (room) => { const k = fitSentences(sents, room); return { n: k.length, text: k.length ? k.join(' ') : cutAtWord(sents[0], room, false) }; };
  const tail = (list, room) => { const k = fitSentences([...list].reverse(), room).reverse(); return k.length ? k.join(' ') : cutAtWord(list[list.length - 1], room, true); };
  if (from === 'end') return `${EXCERPT_GAP} ${tail(sents, max - EXCERPT_GAP.length - 1)}`;
  if (from === 'both') {
    const room = Math.floor((max - EXCERPT_GAP.length - 2) / 2);
    const h = head(room);
    return `${h.text} ${EXCERPT_GAP} ${tail(h.n ? sents.slice(h.n) : sents, room)}`;
  }
  return `${head(max - EXCERPT_GAP.length - 1).text} ${EXCERPT_GAP}`;
}

// One line about the section that holds line `line` of a line model (1-based; a heading line is its own section):
// `Section «2.3 Torsional fitting»: continue its register; it so far says: "<first sentence>".` plus, for a classic
// section type (its own or the enclosing section's: sectionKindOf), one sentence of what the type does (SECTION_HINTS).
// '' when no heading is above the line. A first sentence over SECTION_SAYS_CHARS is cut at a word and marked
// (textExcerpt). opts.skipLine: the first sentence is not taken from the line itself (revise_section sends that paragraph
// anyway); opts.hint false: no type clause.
function sectionExpectation(model, line, opts = {}) {
  const lines = model && Array.isArray(model.lines) ? model.lines : null;
  if (!lines || !(line >= 1)) return '';
  const isHead = (l) => l && l.heading && !l.cell && String(l.text).trim();
  let h = null;
  for (let n = Math.min(line, lines.length); n >= 1; n--) if (isHead(lines[n - 1])) { h = lines[n - 1]; break; }
  if (!h) return '';
  const name = sectionClip(h.text, 80);
  let first = '';
  let body = false;
  for (let n = h.line + 1; n <= lines.length; n++) {
    const l = lines[n - 1];
    if (isHead(l) && l.heading <= h.heading) break;
    if (l.heading || l.cell || !String(l.text).trim()) continue;
    body = true;
    if ((opts.skipLine && n === line) || countWords(l.text) < 5) continue;
    first = splitSentences(l.text)[0] || '';
    if (first) break;
  }
  const quoted = first ? textExcerpt(first, SECTION_SAYS_CHARS) : '';
  let out = first ? `Section «${name}»: continue its register; it so far says: "${quoted}"`
    : body ? `Section «${name}».` : `Section «${name}»: empty so far.`;
  if (first && (quoted.endsWith(EXCERPT_GAP) || !/[.!?…]$/.test(first))) out += '.';
  const kind = opts.hint === false ? null : sectionKindOf(model, h);
  if (kind) out += ` ${SECTION_HINTS[kind]}.`;
  return out;
}

// ---- Criteria for a vague request ---------------------------------------------------------------------------------------
// "Improve the introduction" says what to work on but not what better means. For the classic section types the turn
// context then names a few criteria and asks the model to say which it applied, so the answer is judged on something the
// user can check. The criteria are written in our own words after the section-level criteria of XtraGPT (Chen et al.,
// "XtraGPT: Context-Aware and Controllable Academic Paper Revision via Human-AI Collaboration", arXiv:2505.11336, 2025;
// CC BY 4.0): paraphrased, not copied.
const SECTION_CRITERIA = {
  abstract: ['the problem in its first sentence', 'the approach', 'the main result with its number', 'what the result implies'],
  introduction: ['the first paragraph names the problem for a non-specialist', 'the gap is stated before the contribution',
    'the contributions are listed', 'related work is set against the gap'],
  methods: ['enough detail to repeat the work', 'every parameter with its value and unit', 'the order follows the pipeline', 'no results'],
  results: ['each finding with its number', 'the figure or table pointer after the finding', 'no interpretation', 'the main finding first'],
  discussion: ['each claim tied to a result', 'the comparison with the cited work', 'the limitations named', 'no new results'],
};
// An improve or polish request (English and Russian) that carries no concrete instruction: no length, no operation, no
// quoted text, no named feature of the text, at most VAGUE_MAX_WORDS words.
const VAGUE_MAX_WORDS = 15;
const IMPROVE_RE = /\b(?:improve|polish|refine|enhance|strengthen|rework|better)\b|улучш|доработ|отполир|подтян|лучше/iu;
const CONCRETE_RE = /\b(?:shorten|shorter|trim|cut|condense|expand|longer|add|insert|remove|delete|drop|replace|rename|translate|typos?|grammar|spelling|punctuation|tense|passive|active|cite|citations?|references?|numbers?|words?|sentences?|bullets?|lists?|tables?|figures?|format\w*|bold|italic|fonts?|tone|because)\b|сократ|ужм|добав|удал|убер|замен|перевед|переведи|опечат|граммат|орфограф|пунктуац|цитат|ссылк|слов|предложени|таблиц|рисун|формат|шрифт|тон(?![\p{L}])|потому/iu;
function vagueRequest(text) {
  const t = String(text || '').trim();
  if (!t || countWords(t) > VAGUE_MAX_WORDS || /["«“„:]/.test(t)) return false;
  return IMPROVE_RE.test(t) && !CONCRETE_RE.test(t);
}
// The heading above line n of a line model (a heading line is its own), or null.
function sectionHeadAt(model, n) {
  const lines = model && Array.isArray(model.lines) ? model.lines : [];
  for (let k = Math.min(n, lines.length); k >= 1; k--) { const l = lines[k - 1]; if (l && l.heading && !l.cell && String(l.text).trim()) return l; }
  return null;
}
// The body paragraphs of the section under heading line h (up to the next heading).
function sectionParagraphs(model, h) {
  let n = 0;
  for (let k = h.line + 1; k <= model.lines.length; k++) {
    const l = model.lines[k - 1];
    if (l.heading && !l.cell) break;
    if (!l.cell && String(l.text).trim()) n++;
  }
  return n;
}
// The section a vague request is about: a classic section type the message names whose heading the document has, else the
// section holding the selection. { name, kind } or null. A selection of one paragraph in a section of several is not
// judged by the section's criteria: null. Only a heading that is itself the classic section counts: the criteria judge a
// whole section, so a subsection (whose type sectionKindOf would inherit) is a part of one, like a single paragraph.
function vagueTarget(snap, text) {
  const model = snap && snap.model;
  const heads = model ? model.lines.filter((l) => l.heading && !l.cell && String(l.text).trim()) : [];
  const named = namedSectionKind(text);
  if (named && SECTION_CRITERIA[named]) {
    const h = heads.find((l) => sectionKind(l.text) === named);
    if (h) return { name: sectionClip(h.text, 80), kind: named };
  }
  if (model && snap.selection && typeof locateSelection === 'function') {
    const at = locateSelection(snap);
    const h = at ? sectionHeadAt(model, at.start) : null;
    const kind = h ? sectionKind(h.text) : null;
    if (kind && SECTION_CRITERIA[kind] && !(at.start === at.end && sectionParagraphs(model, h) > 1)) return { name: sectionClip(h.text, 80), kind };
  }
  return null;
}
// The criteria line of the turn context for a vague request on a classic section, or ''.
function criteriaLine(snap, text) {
  if (!vagueRequest(text)) return '';
  const t = vagueTarget(snap, text);
  if (!t) return '';
  return `Criteria for improving «${t.name}» (${t.kind}): ${SECTION_CRITERIA[t.kind].join('; ')}. Use those that fit the text in question; name the ones you used in one short line.`;
}
