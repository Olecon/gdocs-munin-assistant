'use strict';
// Module doc-checks.js: the document-wide passes /check adds to the groups of check-text.js. All are deterministic
// except the journal limits: variant consistency (dcVariants: UK/US spelling, -ise/-ize, hyphenation, numerals 1–9,
// p/P, % / percent, +/- / ±; each group with its majority form and a fix the report's Apply writes), leftovers
// (dcLeftovers), the abstract and the limitations sentence (dcSections), the density block per section (dcDensity),
// wordy phrases (dcWordy, only once concision.js provides concisionHits), and the journal limits of an attached
// author-guidelines file (journalLimitsFor: one quiet model request, stored per document; dcLimits compares).
// docChecks runs them on a ckDocument. A finding has the shape of check-text.js's plus rule (its id, shown in the
// row's fold and named in the DOC.md "Checks:" line), detail (the fold's lines) and fix ({ label, edits: [{ line, at,
// len, to }] }, offsets in the line's text) when the change is mechanical.
/* global anthropicHeaders, apiUrl, bearerHeaders, canRequest, chatBody, CK_ABSTRACT_TITLES, CK_ACRO_ALLOW, CK_ACRO_RE,
   CK_CAPTION_RE, ckAcroKey, ckAllowLine, ckDefinitions, ckSortFindings, ckValidAcronym, claimItems, concisionHits, countWords,
   MUNIN_REASONING_EFFORT, openaiReasoningModel, parseJsonLoose, passiveRate, readDocFileText, samplingFields, sectionKind,
   sentenceSpans, streamAnthropic, streamChat, streamResponses, textLang */
/* exported DC_GROUPS, docChecks, dcVariants, dcLeftovers, dcSections, dcDensity, dcWordy, dcLimits, dcAbstract, dcSpelling,
   DC_BATCH_LINES, JOURNAL_LIMITS_PREFIX, journalLimitsKey, guidelinesFile, parseJournalLimits, journalLimitsFor, JOURNAL_LIMIT_FIELDS */

// The new groups and where they go in the report (after the check-text.js group named by after). optional: shown only
// when the pass has something to say (the journal limits need a guidelines file, the wordy phrases concision.js).
const DC_GROUPS = [
  { id: 'limits', title: 'Journal limits', after: 'budgets', optional: true },
  { id: 'leftovers', title: 'Leftovers', after: 'placeholders' },
  { id: 'consistency', title: 'Consistent forms', after: 'leftovers' },
  { id: 'wordy', title: 'Wordy phrases', after: 'consistency', optional: true },
  { id: 'sections', title: 'Abstract and limitations', after: 'wordy' },
  { id: 'density', title: 'Density per section', after: 'readability' },
];
const DC_MAX_PER_RULE = 10; // rows of one rule before "and N more"
const DC_BATCH_LINES = 50; // edit_document's BATCH_MAX: one Apply rewrites at most this many lines
const dcPlural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const dcClip = (s, n = 60) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const dcFinding = (group, rule, severity, line, at, len, text, extra = {}) => ({ group, kind: rule, rule, severity, line: line || 0, at: at || 0, len: len || 0, text, ...extra });
const dcLines = (list) => { const u = [...new Set(list)]; return u.length > 8 ? `${u.slice(0, 8).join(', ')} and ${u.length - 8} more` : u.join(', '); };
const dcLower = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// ---- What the passes skip ---------------------------------------------------------------------------------------------
// Code-like spans, web and e-mail addresses, DOIs, and citations in brackets: [s, e) ranges of a line.
const DC_SKIP_RES = [
  /`[^`\n]*`/g, /\bhttps?:\/\/\S+|\bwww\.\S+/gi, /\b10\.\d{4,9}\/\S+/g, /[\w.+-]+@[\w-]+\.[\w.-]+/g,
  /\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b|\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b\w+\(\)/g,
];
const DC_CITE_RES = [/\[[^\]\n]{0,80}\]/g, /\([^()\n]{0,120}?\b(?:1[6-9]|20)\d\d[a-z]?\s*\)/g];
function dcMask(text, cites = true) {
  const out = [];
  for (const re of cites ? [...DC_SKIP_RES, ...DC_CITE_RES] : DC_SKIP_RES) for (const m of text.matchAll(re)) out.push([m.index, m.index + m[0].length]);
  return out;
}
const dcFree = (mask, at, end) => !mask.some(([s, e]) => at < e && end > s);
// The lines of running text: the body (no title block, no reference list), not headings or table cells.
const dcRunning = (doc) => doc.body.filter((l) => !l.heading && !l.cell);

// ---- Case -------------------------------------------------------------------------------------------------------------
// The replacement written like the text it replaces: ALL CAPS, Capitalized or as given.
function dcMatchCase(src, to) {
  if (src.length > 1 && src === src.toUpperCase() && src !== src.toLowerCase()) return to.toUpperCase();
  if (src[0] && src[0] !== src[0].toLowerCase()) return to[0].toUpperCase() + to.slice(1);
  return to;
}

// ---- Variant groups ---------------------------------------------------------------------------------------------------
// occ: [{ line, at, len, text, side }] (side: the variant's key); label(side): how a side is named; to(o, side): the
// text o becomes when unified to side. The majority side wins (a tie: the side used first); the other occurrences,
// minus the accepted terms, are the minority the fix rewrites. null when there is nothing to unify.
function dcVariantFinding({ rule, title, occ, label, to, terms, fixLabel, severity = 'note' }) {
  if (!occ.length) return null;
  const n = new Map();
  for (const o of occ) n.set(o.side, (n.get(o.side) || 0) + 1);
  if (n.size < 2) return null;
  const first = new Map();
  for (const o of occ.slice().sort((a, b) => a.line - b.line || a.at - b.at)) if (!first.has(o.side)) first.set(o.side, first.size);
  const sides = [...n.keys()].sort((a, b) => n.get(b) - n.get(a) || first.get(a) - first.get(b));
  const maj = sides[0];
  const minority = occ.filter((o) => o.side !== maj && !terms.has(dcLower(o.text))).sort((a, b) => a.line - b.line || a.at - b.at);
  if (!minority.length) return null;
  const counts = sides.map((s) => `${label(s)} ${dcPlural(n.get(s), 'time')}`).join(', ');
  const edits = minority.map((o) => ({ line: o.line, at: o.at, len: o.len, to: to(o, maj) })).filter((e) => e.to != null);
  const detail = minority.slice(0, 40).map((o) => `line ${o.line}: ${o.text} → ${to(o, maj)}`);
  if (minority.length > 40) detail.push(`and ${minority.length - 40} more`);
  const lines = [...new Set(minority.map((o) => o.line))];
  return dcFinding('consistency', rule, severity, lines[0], minority[0].at, minority[0].len,
    `${title}: ${counts}; unify to ${label(maj)} (${lines.length === 1 ? 'line' : 'lines'} ${dcLines(lines)}).`,
    { detail, fix: edits.length ? { label: fixLabel(label(maj)), edits } : null });
}

// UK / US spelling. Families of a British and an American form with their inflections (dcSpelling builds the word ->
// { side, other } map once); the generic -yse/-yze verbs join them; -ise/-ize is a group of its own, since Oxford
// spelling pairs -ize with British spelling otherwise.
const DC_OUR = 'colour behaviour favour flavour harbour honour humour labour neighbour rumour vapour tumour odour rigour vigour armour endeavour savour'.split(' ');
const DC_RE = ('centre epicentre fibre litre millilitre microlitre metre kilometre centimetre millimetre micrometre nanometre theatre calibre ' +
  'spectre lustre sabre sombre meagre').split(' ');
const DC_LL = 'model label travel cancel signal fuel level channel tunnel total counsel dial marshal jewel equal pedal quarrel rival'.split(' ');
const DC_OGUE = 'catalogue analogue dialogue'.split(' ');
const DC_OTHER = [
  ['grey', 'gray'], ['greys', 'grays'], ['greyish', 'grayish'], ['greyscale', 'grayscale'], ['aluminium', 'aluminum'], ['programme', 'program'],
  ['programmes', 'programs'], ['defence', 'defense'], ['defences', 'defenses'], ['offence', 'offense'], ['offences', 'offenses'], ['ageing', 'aging'],
  ['judgement', 'judgment'], ['judgements', 'judgments'], ['acknowledgement', 'acknowledgment'], ['acknowledgements', 'acknowledgments'],
  ['artefact', 'artifact'], ['artefacts', 'artifacts'], ['mould', 'mold'], ['moulds', 'molds'], ['moulded', 'molded'], ['mouldy', 'moldy'],
  ['sceptical', 'skeptical'], ['sceptic', 'skeptic'], ['sceptics', 'skeptics'], ['scepticism', 'skepticism'], ['fulfil', 'fulfill'],
  ['fulfils', 'fulfills'], ['fulfilment', 'fulfillment'], ['enrol', 'enroll'], ['enrols', 'enrolls'], ['enrolment', 'enrollment'],
  ['skilful', 'skillful'], ['instalment', 'installment'], ['distil', 'distill'], ['plough', 'plow'], ['cosy', 'cozy'], ['jewellery', 'jewelry'],
  ['yoghurt', 'yogurt'], ['aeroplane', 'airplane'], ['manoeuvre', 'maneuver'], ['manoeuvres', 'maneuvers'], ['manoeuvred', 'maneuvered'],
  ['manoeuvring', 'maneuvering'], ['foetus', 'fetus'], ['foetuses', 'fetuses'], ['foetal', 'fetal'], ['oestrogen', 'estrogen'],
  ['oestradiol', 'estradiol'], ['anaemia', 'anemia'], ['anaemic', 'anemic'], ['leukaemia', 'leukemia'],
];
// Word beginnings that differ (haemoglobin / hemoglobin, sulphate / sulfate): [British, American].
const DC_PREFIXES = [['haemo', 'hemo'], ['haema', 'hema'], ['sulph', 'sulf'], ['paediatr', 'pediatr'], ['orthopaed', 'orthoped'],
  ['encyclopaed', 'encycloped'], ['oesophag', 'esophag'], ['anaesthe', 'anesthe'], ['aetiolog', 'etiolog']];
let dcSpellMap = null;
function dcSpelling() {
  if (dcSpellMap) return dcSpellMap;
  const map = new Map();
  const add = (uk, us) => { if (uk !== us) { map.set(uk, { side: 'uk', other: us }); map.set(us, { side: 'us', other: uk }); } };
  for (const s of DC_OUR) for (const x of ['', 's', 'ed', 'ing', 'ful', 'less', 'ite', 'ites', 'able', 'hood', 'hoods']) add(s + x, s.slice(0, -3) + 'or' + x);
  for (const s of DC_RE) { const b = s.slice(0, -2); add(s, b + 'er'); add(s + 's', b + 'ers'); add(b + 'ed', b + 'ered'); add(b + 'ing', b + 'ering'); }
  for (const s of DC_LL) for (const x of ['ed', 'ing', 'er', 'ers']) add(s + 'l' + x, s + x);
  for (const s of DC_OGUE) { const b = s.slice(0, -2); add(s, b); add(s + 's', b + 's'); add(s + 'd', b + 'ed'); add(b + 'uing', b + 'ing'); }
  for (const [uk, us] of DC_OTHER) add(uk, us);
  dcSpellMap = map;
  return map;
}
// The -yse / -yze verbs (analyse, catalyse, hydrolyse; not the plural noun "analyses").
const DC_YSE_RE = /^(\p{L}{3,})y([sz])(e|ed|ing|er|ers)$/u;
// The -ise / -ize verbs and nouns; DC_ISE_NOT: words that end so in both spellings (or are no such verb).
const DC_ISE_RE = /^(\p{L}{2,}?)i([sz])(e|es|ed|ing|er|ers|ation|ations|ational)$/u;
const DC_ISE_NOT = new Set(('rise arise sunrise wise precise concise exercise excise incise circumcise compromise promise premise demise surmise ' +
  'advertise chastise expertise mortise merchandise paradise treatise despise anise valise chemise cerise marquise reprise enterprise apprise ' +
  'comprise surprise franchise crise irise size prize seize capsize maize baize assize downsize').split(' '));
function dcIseSide(word) {
  const m = DC_ISE_RE.exec(word);
  if (!m) return null;
  const ise = m[1] + 'ise';
  const ize = m[1] + 'ize';
  if (/[aeou]$/.test(m[1]) || DC_ISE_NOT.has(ise) || DC_ISE_NOT.has(ize) || /(?:wise|cise|vise|prise)$/.test(ise) || /(?:size|prize|seize)$/.test(ize)) return null;
  return { side: m[2] === 's' ? 'ise' : 'ize', stem: m[1], tail: m[3] };
}
function dcSpellOccurrences(doc, terms) {
  const map = dcSpelling();
  const ukus = [];
  const ize = [];
  for (const l of doc.body) {
    const mask = dcMask(l.text);
    for (const m of l.text.matchAll(/\p{L}+/gu)) {
      if (!dcFree(mask, m.index, m.index + m[0].length)) continue;
      const w = m[0].toLowerCase();
      const o = { line: l.line, at: m.index, len: m[0].length, text: m[0] };
      const hit = map.get(w);
      if (hit) { ukus.push({ ...o, side: hit.side, other: hit.other }); continue; }
      const pre = DC_PREFIXES.find(([uk, us]) => w.startsWith(uk) || (w.startsWith(us) && !w.startsWith(uk)));
      if (pre && w.length > pre[0].length + 1) {
        const uk = w.startsWith(pre[0]);
        ukus.push({ ...o, side: uk ? 'uk' : 'us', other: uk ? pre[1] + w.slice(pre[0].length) : pre[0] + w.slice(pre[1].length) });
        continue;
      }
      const y = DC_YSE_RE.exec(w);
      if (y && !(y[2] === 's' && y[3] === 'es')) {
        ukus.push({ ...o, side: y[2] === 's' ? 'uk' : 'us', other: `${y[1]}y${y[2] === 's' ? 'z' : 's'}${y[3]}` });
        continue;
      }
      const ise = dcIseSide(w);
      if (ise) ize.push({ ...o, side: ise.side, stem: ise.stem, tail: ise.tail });
    }
  }
  const out = [];
  const conv = (o, side) => (o.side === side ? o.text : dcMatchCase(o.text, o.other));
  const f1 = dcVariantFinding({ rule: 'variant-spelling', title: 'UK and US spelling', occ: ukus, label: (s) => (s === 'uk' ? 'UK' : 'US'), to: conv, terms,
    fixLabel: (m) => `the spelling to ${m}` });
  if (f1) out.push(f1);
  const f2 = dcVariantFinding({ rule: 'variant-ize', title: '-ise and -ize', occ: ize, label: (s) => '-' + s, terms, fixLabel: (m) => `the spelling to ${m}`,
    to: (o, side) => dcMatchCase(o.text, `${o.stem}i${side === 'ise' ? 's' : 'z'}${o.tail}`) });
  if (f2) out.push(f2);
  return out;
}

// Hyphenation: "time-resolved", "time resolved" and "timeresolved" are one term (letters without hyphens and spaces);
// two or more forms, each used, make a group of its own. A first part ending in -ly (an adverb) is left out. One pass
// finds the hyphenated terms, a second looks up each word and run of up to four words in them (no regex per term).
const DC_HYPHEN_RE = /(?<![\p{L}\p{N}-])\p{L}{2,}(?:-\p{L}{2,})+(?![\p{L}\p{N}-])/gu;
function dcHyphenFindings(doc, terms) {
  const lines = doc.body.filter((l) => !l.cell).map((l) => ({ l, mask: dcMask(l.text) }));
  const keys = new Map(); // key -> { parts, occ }
  const add = (x, l, at, text, side) => x.occ.push({ line: l.line, at, len: text.length, text, side });
  for (const { l, mask } of lines) {
    for (const m of l.text.matchAll(DC_HYPHEN_RE)) {
      if (!dcFree(mask, m.index, m.index + m[0].length)) continue;
      const parts = m[0].toLowerCase().split('-');
      if (/ly$/.test(parts[0])) continue;
      const key = parts.join('');
      if (!keys.has(key)) keys.set(key, { parts, occ: [] });
      add(keys.get(key), l, m.index, m[0], m[0].toLowerCase());
    }
  }
  if (!keys.size) return [];
  for (const { l, mask } of lines) {
    const words = [...l.text.matchAll(/\p{L}+/gu)];
    for (let i = 0; i < words.length; i++) {
      if (l.text[words[i].index - 1] === '-') continue;
      let joined = '';
      for (let n = 1; n <= 4 && i + n - 1 < words.length; n++) {
        const w = words[i + n - 1];
        if (n > 1 && !/^[ \u00a0]+$/.test(l.text.slice(words[i + n - 2].index + words[i + n - 2][0].length, w.index))) break;
        joined += w[0].toLowerCase();
        const x = keys.get(joined);
        const end = w.index + w[0].length;
        if (!x || l.text[end] === '-' || !dcFree(mask, words[i].index, end)) continue;
        if (n > 1 && (x.parts.length !== n || words.slice(i, i + n).some((t, k) => t[0].toLowerCase() !== x.parts[k]))) continue;
        add(x, l, words[i].index, l.text.slice(words[i].index, end), n === 1 ? joined : x.parts.join(' '));
      }
    }
  }
  const out = [];
  for (const { parts, occ } of keys.values()) {
    const f = dcVariantFinding({ rule: 'variant-hyphen', title: `«${parts.join('-')}»`, occ, label: (s) => `«${s}»`, terms, fixLabel: (m) => `the term to ${m}`,
      to: (o, side) => dcMatchCase(o.text, side) });
    if (f) { f.text = f.text.replace(/^«[^»]+»: /, ''); out.push(f); }
  }
  return out;
}

// Numbers 1–9 in running English text: numerals or words. Left out: table cells, numbers before a unit, a percent
// sign or a range, after Fig./Table/Eq./Section/step…, in brackets (citations, equation labels), a list number at a
// line's start, decimals; "one" (a pronoun as often as a number) and a capitalized word at a sentence start.
const DC_NUM_WORDS = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const DC_UNIT_AFTER_RE = /^(?:\p{L}|[.,:]\d|\s*(?:%|‰|°|×|±|\+|x\b|[-–—]\s*\d|\)|\]|(?:mm|cm|km|nm|µm|μm|um|m|mg|kg|g|µg|μg|ng|ml|mL|µl|µL|μL|l|L|s|ms|min|h|hr|hrs|d|K|°C|M|mM|µM|μM|nM|Hz|kHz|MHz|GHz|kDa|Da|V|mV|W|kW|J|kJ|eV|keV|Pa|kPa|MPa|bar|atm|rpm|ppm|ppb|wt|vol|mol|mmol|µmol|Gy|Bq|years?|months?|weeks?|days?|hours?|minutes?|seconds?|times|fold|log|dB)\b))/u;
const DC_LABEL_BEFORE_RE = /(?:\bfigs?\.?|\bfigures?|\btables?|\btab\.|\beqs?\.?|\bequations?|\bsections?|\bsect\.|\bchapters?|\bsteps?|\bdays?|\bweeks?|\bmonths?|\byears?|\bphases?|\bgroups?|\bno\.|\bversion|\bv|\btypes?|\bgrades?|\bstages?|\blevels?|\bclass|\bpanels?|\blanes?|\bsamples?|\bpatients?|\bexperiments?|\bappendix|\bitems?|\blines?|\bpages?|\bpp?\.|\bvol\.|\bissues?|\bn|\bp|[=<>≤≥±([\-–—+/:.])\s*$/iu;
function dcNumeralFindings(doc, terms) {
  const occ = [];
  for (const l of dcRunning(doc)) {
    if (textLang(l.text) !== 'en') continue;
    const mask = dcMask(l.text);
    for (const m of l.text.matchAll(/(?<![\p{L}\p{N}.,/:–—+±_-])[1-9](?!\p{N})/gu)) {
      const before = l.text.slice(0, m.index);
      if (!before.trim() || DC_UNIT_AFTER_RE.test(l.text.slice(m.index + 1)) || DC_LABEL_BEFORE_RE.test(before) || !dcFree(mask, m.index, m.index + 1)) continue;
      occ.push({ line: l.line, at: m.index, len: 1, text: m[0], side: 'numerals', n: Number(m[0]), start: /[.!?]\s+$/.test(before) });
    }
    for (const m of l.text.matchAll(/(?<![\p{L}\p{N}-])(two|three|four|five|six|seven|eight|nine)(?![\p{L}\p{N}-])/giu)) {
      const before = l.text.slice(0, m.index);
      if (/^\p{Lu}/u.test(m[0]) && (!before.trim() || /[.!?:]\s*$/.test(before))) continue;
      if (!dcFree(mask, m.index, m.index + m[0].length)) continue;
      occ.push({ line: l.line, at: m.index, len: m[0].length, text: m[0], side: 'words', n: DC_NUM_WORDS.indexOf(m[0].toLowerCase()) });
    }
  }
  const f = dcVariantFinding({ rule: 'variant-numeral', title: 'Numbers 1–9 in running text', occ, terms, fixLabel: (m) => `numbers 1–9 to ${m}`,
    label: (s) => s,
    to: (o, side) => (side === 'numerals' ? String(o.n) : o.start ? dcMatchCase('X', DC_NUM_WORDS[o.n]) : DC_NUM_WORDS[o.n]) });
  return f ? [f] : [];
}

// p-values: "p < 0.05" or "P < 0.05", "p-value" or "P-value".
function dcPValueFindings(doc, terms) {
  const occ = [];
  for (const l of dcRunning(doc)) {
    const mask = dcMask(l.text, false);
    for (const m of l.text.matchAll(/(?<![\p{L}\p{N}])([pP])(?=\s*[<=>≤≥]\s*[0.]|[- ]values?\b)/gu)) {
      if (dcFree(mask, m.index, m.index + 1)) occ.push({ line: l.line, at: m.index, len: 1, text: m[1], side: m[1] });
    }
  }
  const f = dcVariantFinding({ rule: 'variant-p', title: 'p-values', occ, terms, label: (s) => `«${s}»`, to: (o, side) => side, fixLabel: (m) => `p-values to ${m}` });
  return f ? [f] : [];
}

// "%" or "percent" ("per cent") after a number; the fix keeps the spacing the document uses most before "%".
function dcPercentFindings(doc, terms) {
  const occ = [];
  let spaced = 0;
  for (const l of dcRunning(doc)) {
    const mask = dcMask(l.text, false);
    for (const m of l.text.matchAll(/(?<=\d)(\s?%|\s+per\s?cent\b)/giu)) {
      if (!dcFree(mask, m.index, m.index + m[0].length)) continue;
      const pct = m[0].trim() === '%';
      if (pct && /\s/.test(m[0])) spaced++;
      occ.push({ line: l.line, at: m.index, len: m[0].length, text: m[0].trim(), side: pct ? '%' : 'percent', spaced: /^\s/.test(m[0]) });
    }
  }
  const pcts = occ.filter((o) => o.side === '%').length;
  const f = dcVariantFinding({ rule: 'variant-percent', title: 'Percent', occ, terms, label: (s) => `«${s}»`, fixLabel: (m) => `percent to ${m}`,
    to: (o, side) => (side === '%' ? (spaced * 2 > pcts ? ' %' : '%') : ' percent') });
  return f ? [f] : [];
}

// "±" or "+/-".
function dcPlusMinusFindings(doc, terms) {
  const occ = [];
  for (const l of dcRunning(doc)) {
    const mask = dcMask(l.text, false);
    for (const m of l.text.matchAll(/±|\+\s?\/\s?[-–]/g)) {
      if (dcFree(mask, m.index, m.index + m[0].length)) occ.push({ line: l.line, at: m.index, len: m[0].length, text: m[0], side: m[0] === '±' ? '±' : '+/-' });
    }
  }
  const f = dcVariantFinding({ rule: 'variant-plusminus', title: 'Plus-minus', occ, terms, label: (s) => `«${s}»`, to: (o, side) => side, fixLabel: (m) => `plus-minus to ${m}` });
  return f ? [f] : [];
}

function dcVariants(doc, { terms = new Set() } = {}) {
  return [...dcSpellOccurrences(doc, terms), ...dcHyphenFindings(doc, terms), ...dcNumeralFindings(doc, terms), ...dcPValueFindings(doc, terms),
    ...dcPercentFindings(doc, terms), ...dcPlusMinusFindings(doc, terms)];
}

// ---- Leftovers ----------------------------------------------------------------------------------------------------------
// Anywhere in the document (title block and reference list included): [rule, severity, regex, text(match)].
const DC_LEFTOVERS = [
  ['leftover-citation', 'error', /\[\s*(?:ref|refs|reference|references|citation needed|citation|cite|source|\?{1,3}|ссылка|ссылки|источник|лит\.?)\s*\]/giu, (m) => `Citation placeholder ${m}.`],
  ['leftover-todo', 'error', /(?<![\p{L}\p{N}_])(?:TODO|TBD|TBA|FIXME|TKTK)(?![\p{L}\p{N}_])/gu, (m) => `${m} left in the text.`],
  ['leftover-insert', 'error', /\[\s*(?:insert|add|вставить|добавить)\b[^\]\n]*\]|<\s*(?:insert|add)\b[^>\n]*>/giu, (m) => `Placeholder ${dcClip(m, 40)}.`],
  ['leftover-marks', 'warning', /(?<!\?)\?{2,}(?!\?)|(?<![\p{L}\p{N}])X{2,3}(?![\p{L}\p{N}])(?![^.\n]{0,8}(?:century|centuries|век))|\d\.x{2,}\b/gu, (m) => `Placeholder mark ${m}.`],
];
// Highlighted text of the Docs API model (a run with a background colour other than white), merged per line.
function dcHighlights(model) {
  const out = [];
  if (!model || !Array.isArray(model.lines)) return out;
  for (const l of model.lines) {
    let cur = null;
    for (const r of l.runs || []) {
      const bg = r.bg && String(r.bg).toLowerCase() !== '#ffffff' ? r.bg : null;
      if (bg && cur && r.s <= cur.e) { cur.e = Math.max(cur.e, r.e); continue; }
      if (cur) out.push(cur);
      cur = bg ? { line: l.line, s: r.s, e: r.e } : null;
    }
    if (cur) out.push(cur);
  }
  return out;
}
// Rows of one rule beyond DC_MAX_PER_RULE go into one note "and N more" (the first kept).
function dcCap(list, rule, what) {
  const own = list.filter((f) => f.rule === rule);
  if (own.length <= DC_MAX_PER_RULE) return list;
  const drop = new Set(own.slice(DC_MAX_PER_RULE));
  const rest = own.slice(DC_MAX_PER_RULE).map((f) => f.line);
  return [...list.filter((f) => !drop.has(f)), dcFinding('leftovers', rule, 'note', 0, 0, 0, `${what} on ${dcPlural(rest.length, 'more line')}: ${dcLines(rest)}.`)];
}
function dcLeftovers(doc, { model = null, terms = new Set() } = {}) {
  let out = [];
  for (const l of doc.lines) {
    if (!l.text.trim()) continue;
    const mask = dcMask(l.text, false).concat([...l.text.matchAll(/\[\[[^\]\n]*\]\]/g)].map((m) => [m.index, m.index + m[0].length]));
    for (const [rule, severity, re, say] of DC_LEFTOVERS) {
      for (const m of l.text.matchAll(re)) {
        if (!dcFree(mask, m.index, m.index + m[0].length) || terms.has(dcLower(m[0]))) continue;
        out.push(dcFinding('leftovers', rule, severity, l.line, m.index, m[0].length, say(m[0]), { term: m[0] }));
      }
    }
    if (!l.cell) {
      const sp = /(?<=\S) {2,}(?=\S)/.exec(l.text);
      if (sp && dcFree(mask, sp.index, sp.index + sp[0].length)) out.push(dcFinding('leftovers', 'double-space', 'note', l.line, sp.index, sp[0].length, 'Double space.'));
    }
    for (const m of l.text.matchAll(/,,|;;|::|(?<!\.)\.\.(?!\.)|[,;:]\s*\.(?!\.)|,\s*;|;\s*,|!!/g)) {
      if (!dcFree(mask, m.index, m.index + m[0].length)) continue;
      out.push(dcFinding('leftovers', 'double-punct', 'note', l.line, m.index, m[0].length, `Double punctuation «${m[0]}».`));
      break;
    }
  }
  for (const h of dcHighlights(model)) {
    const l = doc.lines[h.line - 1];
    const text = l ? l.text.slice(h.s, h.e) : '';
    if (!text.trim() || terms.has(dcLower(text))) continue;
    out.push(dcFinding('leftovers', 'leftover-highlight', 'warning', h.line, h.s, h.e - h.s, `Highlighted text «${dcClip(text, 40)}».`, { term: text }));
  }
  for (const [rule, what] of [['double-space', 'Double spaces'], ['double-punct', 'Double punctuation'], ['leftover-marks', 'Placeholder marks']]) out = dcCap(out, rule, what);
  return out;
}

// ---- The abstract and the limitations sentence ---------------------------------------------------------------------
const DC_ABSTRACT_INLINE_RE = /^\s*(?:abstract|summary|аннотация|реферат|резюме)\s*[:.—–-]\s*(\S.*)$/iu;
// { line, title, text, lines } of the abstract: the section under an Abstract heading (check-text.js's names), or a
// paragraph of the title block that starts with "Abstract:"; null when there is none.
function dcAbstract(doc) {
  const sec = doc.sections.find((s) => CK_ABSTRACT_TITLES.includes(s.norm));
  if (sec) {
    const lines = doc.lines.filter((l) => l.line >= sec.from && l.line <= sec.to && !l.heading && !l.cell && l.text.trim());
    return { line: sec.line, title: sec.title, text: lines.map((l) => l.text).join('\n'), lines };
  }
  for (const l of doc.lines) {
    if (!doc.inTitle(l.line)) break;
    const m = DC_ABSTRACT_INLINE_RE.exec(l.text);
    if (m) return { line: l.line, title: 'Abstract', text: m[1], lines: [l] };
  }
  return null;
}
const DC_DISCUSSION_RE = /^(?:(?:results and )?discussions?|conclusions?|conclusion and outlook|conclusions and outlook|summary and conclusions?|discussion and conclusions?|concluding remarks|general discussion|обсуждение(?: результатов)?|результаты и обсуждение|заключение|выводы)$/u;
const DC_LIMITS_TEXT_RE = /\b(?:limitations?|limited by|caveats?|shortcomings?|drawbacks?|weakness(?:es)?)\b|ограничени|недостат/iu;
const DC_ABSTRACT_DEFAULT = 250;
// opts: { limits (the journal limits record), budget (check-text.js's budget line), instructions }.
function dcSections(doc, { limits = null, budget = null, instructions = '' } = {}) {
  const out = [];
  const abs = dcAbstract(doc);
  if (abs) {
    const words = countWords(abs.text);
    const journal = limits && limits.limits && limits.limits.abstract_words;
    const budgeted = budget && budget.limits.some((b) => /^(?:abstract|summary|аннотация|реферат|резюме)/u.test(b.name));
    const limit = journal || (budgeted ? 0 : DC_ABSTRACT_DEFAULT);
    if (limit && words > limit) {
      out.push(dcFinding('sections', 'abstract-length', 'warning', abs.line, 0, 0,
        `Abstract: ${words} words, ${words - limit} over ${limit}${journal ? ` (the limit of ${limits.title})` : ' (a common limit)'}.`));
    }
    const cites = claimItems(abs.text).citations.filter((c) => !/^10\./.test(c.key));
    if (cites.length) {
      const where = abs.lines.find((l) => cites.some((c) => l.text.includes(c.text))) || abs.lines[0];
      out.push(dcFinding('sections', 'abstract-citation', 'warning', where ? where.line : abs.line, 0, 0,
        `The abstract cites ${[...new Set(cites.map((c) => c.text))].slice(0, 4).join(', ')}; an abstract usually stands without citations.`));
    }
    const allow = ckAllowLine(instructions);
    const defined = new Set();
    for (const l of abs.lines) for (const d of ckDefinitions(l.text)) defined.add(d.key);
    const undefinedAt = new Map();
    for (const l of abs.lines) {
      if (!/\p{Ll}/u.test(l.text)) continue;
      for (const m of l.text.matchAll(CK_ACRO_RE)) {
        const key = ckAcroKey(m[1]);
        if (!ckValidAcronym(m[1]) || CK_ACRO_ALLOW.has(key) || allow.has(key) || defined.has(key) || undefinedAt.has(key)) continue;
        undefinedAt.set(key, { line: l.line, at: m.index, sf: m[1] });
      }
    }
    if (undefinedAt.size) {
      const list = [...undefinedAt.values()];
      out.push(dcFinding('sections', 'abstract-abbreviation', 'warning', list[0].line, list[0].at, list[0].sf.length,
        `The abstract uses ${list.map((x) => x.sf).join(', ')} without defining ${list.length === 1 ? 'it' : 'them'} there.`));
    }
  }
  const disc = doc.sections.filter((s) => DC_DISCUSSION_RE.test(s.norm));
  // A limitations section by its whole heading (sectionKind): "Existing approaches and their limitations" is not one.
  if (disc.length && !doc.sections.some((s) => sectionKind(s.title) === 'limitations')) {
    const said = disc.some((s) => doc.lines.some((l) => l.line >= s.from && l.line <= s.to && DC_LIMITS_TEXT_RE.test(l.text)));
    if (!said) {
      out.push(dcFinding('sections', 'limitations-missing', 'warning', disc[0].line, 0, 0,
        `${disc.map((s) => s.title).join(' and ')}: no sentence on the study's limitations (limitation, caveat, shortcoming).`));
    }
  }
  return out;
}

// ---- Density per section ----------------------------------------------------------------------------------------------
// The most common function words of English and Russian (the "glue" of a sentence).
const DC_GLUE = new Set(('a an the and or but nor so yet for of to in on at by with from into onto upon about above below over under between among ' +
  'through during before after since until while as than then that this these those there here which who whom whose what when where why how ' +
  'whether if because although though unless whereas also however thus therefore hence moreover furthermore indeed not no only just even ' +
  'very more most less least much many few some any all each every both either neither other another such same own is are was were be been ' +
  'being am has have had having do does did done can could may might must shall should will would it its it\'s they them their theirs we us our ' +
  'ours you your he him his she her hers i me my one ones itself themselves ourselves via per against along around across within without ' +
  'toward towards upon whereby wherein out up down off again further once too quite rather well still already almost often always never ' +
  'sometimes usually perhaps maybe like unlike near nearly mainly mostly partly largely respectively namely etc i.e e.g ' +
  'и в во не на с со что как по к ко у о об от до за из для при но а же ли или то это этот эта эти тот та те так также ' +
  'был была было были быть есть будет будут который которая которое которые которых которым его ее её их им ими он она оно они мы ' +
  'вы я нас вас нам вам себя свой своя свои своих все всё всех весь вся уже еще ещё только даже ни бы если чтобы когда где там тут ' +
  'здесь потому поэтому однако хотя между через под над перед после без около более менее очень можно нужно при этом том тем чем').split(/\s+/));
const DC_NOMINAL_EN_RE = /^\p{L}{4,}(?:tion|sion|ment|ness|ance|ence|ity|ism|isation|ization)s?$/u;
const DC_NOMINAL_RU_RE = /^\p{L}{3,}(?:ание|ение|ания|ения|анию|ению|анием|ением|ость|ости|остью|ация|ации|ацию|ацией|ство|ства|ству|ством)$/u;
const DC_PASSIVE_EN_RE = /\b(?:am|is|are|was|were|be|been|being)\s+(?:\w+ly\s+)?(?:\w+ed|\w+en|made|done|found|shown|known|seen|given|taken|built|kept|held|set|put|run|thought|brought|sought|taught|left|lost|led|read|sent|spent|told|understood|chosen|grown|drawn)\b/i;
const DC_PASSIVE_RU_RE = /(?:^|[\s,(])\p{L}{3,}(?:ан|ян|ен|ён|ана|ено|ены|ано|аны|яна|яно|яны)(?=$|[\s,.;:)])|\p{L}{3,}(?:ется|ются|ится|ятся|ался|алась|алось|ались|ился|илась|илось|ились)(?=$|[\s,.;:)])/iu;
const DC_GLUE_HIGH = 0.45;
const DC_LONG_SHARE_HIGH = 0.25;
const DC_DENSITY_MIN_WORDS = 40;
const dcPct = (x) => `${Math.round(x * 100)}%`;
// The passive share of sentences: passiveRate of doc-conventions.js when it is loaded (a share 0..1, a percentage or
// { rate }), else the regexes above.
function dcPassive(text, sentences, lang) {
  if (typeof passiveRate === 'function') {
    try {
      const r = passiveRate(text);
      const v = typeof r === 'number' ? r : r && typeof r.rate === 'number' ? r.rate : null;
      if (v != null && Number.isFinite(v)) return v > 1 ? v / 100 : v;
    } catch (e) { /* the local count below */ }
  }
  const re = lang === 'ru' ? DC_PASSIVE_RU_RE : DC_PASSIVE_EN_RE;
  return sentences.length ? sentences.filter((s) => re.test(s.text)).length / sentences.length : 0;
}
// { rows: [{ title, line, words, longShare, glue, nominal, passive, high: [] }], worst: { title, line, sentences: [{ text,
// words, line }] } | null }: per section of 40+ words (its own lines, no table cells; the reference list left out).
function dcDensity(doc) {
  const rows = [];
  for (const sec of doc.sections) {
    if (doc.bib && sec === doc.bib) continue;
    const lines = doc.lines.filter((l) => l.line >= sec.from && l.line <= sec.ownTo && !l.cell && !l.heading && l.text.trim());
    const text = lines.map((l) => l.text).join('\n');
    const wordsList = (text.match(/[\p{L}\p{N}]+(?:['’.][\p{L}]+)*/gu) || []).map((w) => w.toLowerCase());
    const words = countWords(text);
    if (words < DC_DENSITY_MIN_WORDS) continue;
    const lang = textLang(text);
    const spans = sentenceSpans(text, lang);
    const sentences = spans.map((s) => {
      let at = 0; let k = 0;
      for (; k < lines.length; k++) { if (s.start < at + lines[k].text.length + 1) break; at += lines[k].text.length + 1; }
      return { text: s.text, words: countWords(s.text), line: (lines[k] || lines[lines.length - 1]).line };
    });
    const longLimit = lang === 'ru' ? 35 : 30;
    const longShare = sentences.length ? sentences.filter((s) => s.words > longLimit).length / sentences.length : 0;
    const glue = wordsList.length ? wordsList.filter((w) => DC_GLUE.has(w)).length / wordsList.length : 0;
    const nominalRe = lang === 'ru' ? DC_NOMINAL_RU_RE : DC_NOMINAL_EN_RE;
    const nominal = wordsList.length ? (wordsList.filter((w) => nominalRe.test(w)).length * 100) / wordsList.length : 0;
    const passive = dcPassive(text, sentences, lang);
    const high = [];
    if (longShare > DC_LONG_SHARE_HIGH) high.push('long');
    if (glue > DC_GLUE_HIGH) high.push('glue');
    rows.push({ title: sec.title, line: sec.line, words, longLimit, longShare, glue, nominal, passive, high, sentences });
  }
  let worst = null;
  for (const r of rows) {
    if (!worst || r.high.length > worst.high.length || (r.high.length === worst.high.length && r.longShare > worst.longShare)) worst = r;
  }
  const out = {
    rows: rows.map(({ sentences, ...r }) => r),
    worst: worst ? { title: worst.title, line: worst.line, sentences: worst.sentences.slice().sort((a, b) => b.words - a.words).slice(0, 3) } : null,
  };
  return out;
}
// The block's lines: one per section, then the worst section's three longest sentences.
function dcDensityLines(d) {
  const out = d.rows.map((r) => ({
    line: r.line,
    text: `${r.title}: ${r.words} words · over ${r.longLimit} words ${dcPct(r.longShare)}${r.high.includes('long') ? ' (high)' : ''} · glue ${dcPct(r.glue)}${r.high.includes('glue') ? ' (high)' : ''} · nominalizations ${r.nominal.toFixed(1)}/100 · passive ${dcPct(r.passive)}`,
  }));
  if (d.worst && d.worst.sentences.length) {
    out.push({ line: d.worst.line, text: `Longest sentences in ${d.worst.title}:` });
    for (const s of d.worst.sentences) out.push({ line: s.line, text: `«${dcClip(s.text, 140)}» (${s.words} words)`, quote: true });
  }
  return out;
}

// ---- Wordy phrases (concision.js) ---------------------------------------------------------------------------------------
// concisionHits(text) of the per-write checks, once loaded: [{ phrase | text | match, suggestion | replacement | fix,
// at | index | start, mechanical (true: a plain swap the report may Apply), id }] (or { hits: [...] }). Absent: no group.
function dcWordy(doc, { terms = new Set() } = {}) {
  if (typeof concisionHits !== 'function') return null;
  const out = [];
  for (const l of dcRunning(doc)) {
    let hits;
    try { hits = concisionHits(l.text); } catch (e) { hits = []; }
    if (hits && !Array.isArray(hits)) hits = hits.hits || [];
    for (const h of hits || []) {
      const phrase = String(h.phrase || h.text || h.match || '');
      if (!phrase || terms.has(dcLower(phrase))) continue;
      // concision.js gives `to`: '' means drop the phrase, a leading '=' an instruction rather than a literal replacement.
      const raw = h.suggestion != null ? h.suggestion : h.replacement != null ? h.replacement : h.fix != null ? h.fix : h.to;
      const sugg = typeof raw === 'string' && raw.startsWith('=') ? raw.slice(1).trim() : raw;
      const literal = typeof raw === 'string' && !raw.startsWith('=');
      const atRaw = h.at != null ? h.at : h.index != null ? h.index : h.start;
      const at = Number.isInteger(atRaw) && l.text.substr(atRaw, phrase.length) === phrase ? atRaw : l.text.indexOf(phrase);
      if (at < 0) continue;
      const rule = typeof h.id === 'string' && h.id ? (h.id.startsWith('wordy') ? h.id : 'wordy-' + h.id) : 'wordy-phrase';
      const mech = (h.mechanical === true || h.kind === 'mechanical') && literal;
      const said = typeof sugg !== 'string' ? `«${phrase}».` : !literal ? `«${phrase}»: ${sugg}.` : sugg ? `«${phrase}» → «${sugg}».` : `«${phrase}» → drop it.`;
      out.push(dcFinding('wordy', rule, 'note', l.line, at, phrase.length, said,
        mech ? { fix: { label: `«${phrase}» to «${sugg}»`, edits: [{ line: l.line, at, len: phrase.length, to: sugg ? dcMatchCase(phrase, sugg) : '' }] } } : {}));
    }
  }
  return out;
}

// ---- Journal limits ---------------------------------------------------------------------------------------------------------
const JOURNAL_LIMITS_PREFIX = 'muninJournalLimits:';
const journalLimitsKey = (docId) => JOURNAL_LIMITS_PREFIX + docId;
// The limits read from the guidelines, in report order: [field, label, unit].
const JOURNAL_LIMIT_FIELDS = [
  ['title_characters', 'Title', 'characters'], ['abstract_words', 'Abstract', 'words'], ['keywords', 'Keywords', 'keywords'],
  ['highlights_words', 'Highlights', 'words'], ['summary_words', 'Summary', 'words'], ['total_words', 'Whole document', 'words'],
  ['figures', 'Figures', 'figures'], ['tables', 'Tables', 'tables'], ['references', 'References', 'references'],
];
const DC_GUIDE_NAME_RE = /guideline|guide (?:for|to) authors|authors?'?s? guide|instructions? (?:for|to) authors|author instructions|submission|правила для авторов|требования к (?:рукопис|стат|оформлени)|для авторов/iu;
// The attached file that holds author guidelines: by its name, else by its first 20 lines. { file, text } or null.
async function guidelinesFile(docId, files) {
  const list = Array.isArray(files) ? files : [];
  for (const f of list) {
    if (!DC_GUIDE_NAME_RE.test(String(f.title || ''))) continue;
    const text = await readDocFileText(docId, f.alias);
    if (text) return { file: f, text };
  }
  for (const f of list) {
    if (DC_GUIDE_NAME_RE.test(String(f.title || ''))) continue;
    const text = await readDocFileText(docId, f.alias);
    if (text && DC_GUIDE_NAME_RE.test(text.split('\n').slice(0, 20).join('\n'))) return { file: f, text };
  }
  return null;
}
const dcFileSig = (f) => `${f.alias}|${f.title || ''}|${f.size || 0}|${f.addedAt || 0}|${f.lines || 0}`;
// The lines of the guidelines that state a limit (a number near a limit word), with the line before each; the first
// 12,000 characters when none do.
const DC_LIMIT_WORD_RE = /\d/;
const DC_LIMIT_TOPIC_RE = /words?|characters?|figures?|tables?|references?|keywords?|key words|abstract|highlights?|summary|title|pages?|слов|знак|символ|рисун|таблиц|ссыл|литератур|ключев|аннотац|страниц/iu;
function dcLimitsMaterial(text) {
  const lines = String(text || '').split('\n');
  const keep = new Set();
  lines.forEach((l, i) => { if (DC_LIMIT_WORD_RE.test(l) && DC_LIMIT_TOPIC_RE.test(l)) { keep.add(i); if (i) keep.add(i - 1); } });
  const picked = [...keep].sort((a, b) => a - b).map((i) => lines[i].trim()).filter(Boolean).join('\n');
  return (picked || String(text || '')).slice(0, 12000);
}
const DC_LIMITS_PROMPT = 'You read journal author guidelines and extract numeric maximums. Answer with one JSON object only, no other text: ' +
  '{"abstract_words": n, "title_characters": n, "keywords": n, "total_words": n, "figures": n, "tables": n, "references": n, ' +
  '"highlights_words": n, "summary_words": n}. Use null when the guidelines do not state the limit. Title limits in words: ' +
  'leave title_characters null. Highlights limits per bullet: give the total if stated, else null.';
const DC_LIMITS_REPLY_TOKENS = { munin: 1024, openai: 2048, anthropic: 300 };
// The quiet request (like the chat title's): no tools, one attempt.
function dcLimitsRequest(snap, user) {
  const { prov, cfg } = snap;
  if (prov.id === 'openai') {
    const body = { model: cfg.model, instructions: DC_LIMITS_PROMPT, input: [{ role: 'user', content: user }], max_output_tokens: DC_LIMITS_REPLY_TOKENS.openai, stream: true, store: false };
    if (openaiReasoningModel(cfg.model)) body.reasoning = { effort: 'low' };
    return { kind: 'responses', url: apiUrl(snap, '/responses'), headers: bearerHeaders(cfg), body, tools: [] };
  }
  if (prov.id === 'anthropic') {
    const body = { model: cfg.model, max_tokens: DC_LIMITS_REPLY_TOKENS.anthropic, system: DC_LIMITS_PROMPT, messages: [{ role: 'user', content: user }], stream: true };
    return { kind: 'anthropic', url: apiUrl(snap, '/messages'), headers: anthropicHeaders(cfg), body, tools: [] };
  }
  const body = {
    model: cfg.model, persona: 'raw', max_tokens: DC_LIMITS_REPLY_TOKENS.munin, stream: true, stream_options: { include_usage: true },
    messages: [{ role: 'system', content: DC_LIMITS_PROMPT }, { role: 'user', content: user }],
    chat_template_kwargs: { reasoning_effort: MUNIN_REASONING_EFFORT }, ...samplingFields(prov, 'summary'),
  };
  return { kind: 'chat', url: apiUrl(snap, '/chat/completions'), headers: bearerHeaders(cfg), body: chatBody(prov, body), tools: [] };
}
async function dcExtractLimits(snap, material, signal) {
  const req = dcLimitsRequest(snap, material);
  const run = req.kind === 'responses' ? streamResponses : req.kind === 'anthropic' ? streamAnthropic : streamChat;
  return (await run(req, signal, snap, {})).content;
}
const DC_LIMIT_ALIASES = {
  abstract_words: ['abstract_words', 'abstract', 'abstractWords'], title_characters: ['title_characters', 'title', 'titleCharacters', 'title_chars'],
  keywords: ['keywords', 'keyword_count', 'keywords_count'], total_words: ['total_words', 'total', 'word_count', 'words', 'totalWords'],
  figures: ['figures', 'figure_count', 'max_figures'], tables: ['tables', 'table_count', 'max_tables'], references: ['references', 'reference_count', 'max_references'],
  highlights_words: ['highlights_words', 'highlights'], summary_words: ['summary_words', 'summary', 'lay_summary_words'],
};
// The model's answer as { field: positive integer } (only the stated ones), or null when it states none.
function parseJournalLimits(raw) {
  const v = parseJsonLoose(raw);
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const src = v.limits && typeof v.limits === 'object' ? v.limits : v;
  const out = {};
  for (const [field, names] of Object.entries(DC_LIMIT_ALIASES)) {
    const k = names.find((n) => src[n] != null);
    if (!k) continue;
    const m = /\d[\d\s,]*/.exec(String(src[k]));
    const n = m ? Number(m[0].replace(/[\s,]/g, '')) : NaN;
    if (Number.isInteger(n) && n > 0 && n < 1e6) out[field] = n;
  }
  return Object.keys(out).length ? out : null;
}
// The journal limits for /check: null without a guidelines file; else { alias, title, limits } (limits null when the
// extraction failed). Stored per document with the file's signature, so a changed or replaced file is read again; a
// failure is not stored (the next /check asks again). opts: { docId, files, snap (the chat's provider), signal,
// onStatus, extract (tests: a fake model, (material) -> answer text) }.
async function journalLimitsFor({ docId, files, snap = null, signal = null, onStatus = null, extract = null } = {}) {
  if (!docId) return null;
  const found = await guidelinesFile(docId, files);
  if (!found) return null;
  const { file, text } = found;
  const base = { alias: file.alias, title: String(file.title || file.alias) };
  const key = journalLimitsKey(docId);
  const sig = dcFileSig(file);
  let stored = null;
  try { stored = (await chrome.storage.local.get(key))[key]; } catch (e) { stored = null; }
  if (stored && stored.sig === sig && stored.limits) return { ...base, limits: stored.limits };
  if (!extract && !(snap && snap.prov && snap.cfg && canRequest(snap.cfg))) return { ...base, limits: null };
  if (onStatus) onStatus(`Check: reading the limits in ${base.title}…`);
  let limits = null;
  try {
    const material = dcLimitsMaterial(text);
    limits = parseJournalLimits(extract ? await extract(material) : await dcExtractLimits(snap, material, signal));
  } catch (e) {
    limits = null; // a failure or Stop: the report says the limits were not extracted (Stop ends the report anyway)
  }
  if (limits) {
    try { await chrome.storage.local.set({ [key]: { sig, alias: file.alias, title: base.title, limits, at: Date.now() } }); } catch (e) { /* kept for this report */ }
  }
  return { ...base, limits };
}
// The document's value of each limit: { field: number | null }. entries: the reference list's parsed entries.
function dcLimitValues(doc, entries = []) {
  const titleLine = doc.lines.find((l) => l.title && l.text.trim()) || doc.lines.find((l) => doc.inTitle(l.line) && l.text.trim());
  const abs = dcAbstract(doc);
  const kw = doc.lines.find((l) => /^\s*(?:key\s*words|keywords|ключевые слова)\s*[:.—–-]/iu.test(l.text));
  const sectionWords = (re) => {
    const sec = doc.sections.find((s) => re.test(s.norm));
    if (!sec) return null;
    return countWords(doc.lines.filter((l) => l.line >= sec.from && l.line <= sec.to && !l.heading).map((l) => l.text).join('\n'));
  };
  const captions = (re) => new Set(doc.lines.map((l) => (re.exec(l.text) || [])[1]).filter(Boolean)).size;
  return {
    title_characters: titleLine ? titleLine.text.trim().length : null,
    abstract_words: abs ? countWords(abs.text) : null,
    keywords: kw ? kw.text.replace(/^[^:.—–-]*[:.—–-]/u, '').split(/[,;·•]/).filter((s) => s.trim()).length : null,
    highlights_words: sectionWords(/^(?:highlights|key points)$/u),
    summary_words: sectionWords(/^(?:lay summary|plain language summary|significance(?: statement)?|author summary)$/u),
    total_words: countWords(doc.body.filter((l) => !l.heading).map((l) => l.text).join('\n')),
    figures: captions(CK_CAPTION_RE.figure),
    tables: captions(CK_CAPTION_RE.table),
    references: entries.length,
  };
}
// The "Journal limits" group: each stated limit with the document's value (over: a warning; within or not found: a note).
function dcLimits(doc, rec, { entries = [] } = {}) {
  if (!rec) return null;
  if (!rec.limits) return [dcFinding('limits', 'journal-limits', 'note', 0, 0, 0, `Journal limits: not extracted from ${rec.title}; attach the author guidelines as text.`)];
  const vals = dcLimitValues(doc, entries);
  const out = [];
  for (const [field, label, unit] of JOURNAL_LIMIT_FIELDS) {
    const limit = rec.limits[field];
    if (!limit) continue;
    const v = vals[field];
    const rule = 'limit-' + field.replace(/_.*$/, '');
    if (v == null || (v === 0 && /^(?:keywords|highlights|summary)/.test(field))) {
      out.push(dcFinding('limits', rule, 'note', 0, 0, 0, `${label}: at most ${limit} ${unit}; not found in the document.`));
    } else if (v > limit) {
      out.push(dcFinding('limits', rule, 'warning', 0, 0, 0, `${label}: ${v} ${unit}, ${v - limit} over the limit of ${limit}.`));
    } else {
      out.push(dcFinding('limits', rule, 'note', 0, 0, 0, `${label}: ${v} of at most ${limit} ${unit}.`));
    }
  }
  out.push(dcFinding('limits', 'journal-limits', 'note', 0, 0, 0, `Limits from ${rec.title} (${rec.alias}).`));
  return out;
}

// ---- All passes ---------------------------------------------------------------------------------------------------------------
// doc: ckDocument; opts: { model (the Docs API line model, for highlights), instructions, terms (accepted terms, Set),
// limits (journalLimitsFor's record or null), entries, budget }. { groups: { id: [findings] }, density }; an optional
// group is left out when its pass does not run.
function docChecks(doc, { model = null, instructions = '', terms = new Set(), limits = null, entries = [], budget = null } = {}) {
  const groups = {
    leftovers: dcLeftovers(doc, { model, terms }),
    consistency: dcVariants(doc, { terms }),
    sections: dcSections(doc, { limits, budget, instructions }),
  };
  const wordy = dcWordy(doc, { terms });
  if (wordy) groups.wordy = wordy;
  const lim = dcLimits(doc, limits, { entries });
  if (lim) groups.limits = lim;
  for (const id of Object.keys(groups)) if (id !== 'limits') groups[id] = ckSortFindings(groups[id]);
  const density = dcDensity(doc);
  return { groups, density: { ...density, lines: dcDensityLines(density) } };
}
