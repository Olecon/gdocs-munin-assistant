'use strict';
// Module check-refs.js: the reference-list check of /check against Crossref and OpenAlex (only with the References
// grant: the optional host permissions, asked for on a chat card, references.js). An entry with a DOI is looked up in Crossref (crossrefMeta of zotero.js)
// and compared by title (normalized similarity, CK_TITLE_MATCH), the authors (surnames with diacritics folded and
// particles dropped; beyond the first author at least CK_AUTHOR_MATCH of them in the same order), the year and the
// venue (common abbreviations: J., Phys., Chem., Rev., Lett., Proc., Int., Zh.); an entry without a DOI is searched in
// OpenAlex (works?search=) and then in Crossref (works?query.bibliographic=). A preprint (arXiv, bioRxiv, medRxiv,
// ChemRxiv, SSRN) is not looked up. Verdicts (ckVerdict): error (the DOI resolves to another work), warning (year,
// authors or venue differ), unverified (a preprint, or no hit: never "fake"; books, theses and reports are often not
// indexed), suspect (no hit in both sources and the venue is unknown to OpenAlex). Requests run one at a time with a
// pause, at most CK_REF_MAX entries, and stop on the signal. The same run serves the reading tool check_references
// (ckReferencesText), and ckFormatCsl writes a Crossref record as a plain-text entry for /check's Replace button.
/* global CROSSREF_URL, crossrefMeta, ckDocument, ckEntries, ckNormName, htmlToText, offersOpenDocument, OPENALEX_URL, refsOffered, registerTools, withReferences,
   setStatus */
/* exported ckVerifyReferences, ckCheckEntry, ckVerdict, ckTitleSimilarity, CK_REF_MAX, ckOpenAlexAllowed, ckSameSurname, ckEntryAuthors,
   ckAuthorMatch, ckVenueMatches, ckPreprint, ckFormatCsl, ckCitationStyle, ckEntryPrefix, ckReferencesText, ckFromCsl */

const CK_REF_MAX = 50;
const CK_REF_DELAY_MS = 300; // between requests: Crossref and OpenAlex ask for a polite rate
const CK_REF_TIMEOUT_MS = 15000;
const CK_TITLE_MATCH = 0.8;
const CK_AUTHOR_MATCH = 0.6; // share of the entry's authors found in the same order

// ---- Comparing ---------------------------------------------------------------------------------------------------------
const ckTitleNorm = (t) => ckNormName(t).replace(/<[^>]+>/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const ckBigrams = (s) => { const out = new Map(); for (let i = 0; i < s.length - 1; i++) { const b = s.slice(i, i + 2); out.set(b, (out.get(b) || 0) + 1); } return out; };
// Dice's coefficient of the character bigrams of the normalized titles; a title that is the other one's main title
// (before a colon) or covers its words also counts.
function ckTitleSimilarity(a, b) {
  const x = ckTitleNorm(a);
  const y = ckTitleNorm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const dice = (p, q) => {
    const bp = ckBigrams(p);
    const bq = ckBigrams(q);
    let common = 0;
    for (const [k, n] of bp) common += Math.min(n, bq.get(k) || 0);
    const total = Math.max(1, p.length - 1) + Math.max(1, q.length - 1);
    return (2 * common) / total;
  };
  const main = (t) => ckTitleNorm(String(t).split(/[:.?]\s/)[0]);
  return Math.max(dice(x, y), dice(main(a), main(b)) * 0.98);
}
// The share of the work's title words (3+ letters) that occur in the entry's text: the entry's title may be cut wrongly.
function ckTitleCover(entryText, title) {
  const words = ckTitleNorm(title).split(' ').filter((w) => w.length >= 3);
  if (words.length < 3) return 0;
  const have = new Set(ckTitleNorm(entryText).split(' '));
  return words.filter((w) => have.has(w)).length / words.length;
}
// ---- Authors -------------------------------------------------------------------------------------------------------------
// Name particles left out of a surname key ("van der Waals" = "Waals", "de Vries" = "Vries"; not the last word).
const CK_PARTICLES = new Set(['van', 'von', 'der', 'den', 'de', 'del', 'della', 'di', 'da', 'du', 'dos', 'das', 'le', 'la', 'ten', 'ter', 'zu', 'vander', 'vanden']);
// A surname as comparison parts: lowercase, diacritics and ё folded, particles dropped, split at hyphens ("García-Márquez"
// -> ['garcia', 'marquez']).
function ckSurnameParts(name) {
  const words = ckNormName(name).replace(/['’]/g, '').split(/\s+/).filter(Boolean);
  const kept = words.filter((w, i) => i === words.length - 1 || !CK_PARTICLES.has(w.replace(/[^\p{L}]/gu, '')));
  return kept.join(' ').split(/[\s\-‐‑]+/).map((w) => w.replace(/[^\p{L}]/gu, '')).filter(Boolean);
}
// The same surname: equal keys, or a double surname given once in full and once by one part.
function ckSameSurname(a, b) {
  const x = ckSurnameParts(a);
  const y = ckSurnameParts(b);
  if (!x.length || !y.length) return false;
  if (x.join('') === y.join('')) return true;
  return (x.length > 1) !== (y.length > 1) && (x.length > 1 ? x : y).includes((x.length > 1 ? y : x).join(''));
}
const ckSameName = ckSameSurname;
// An initials token: "J.", "KM", "J.-P.", "И.И.".
const CK_INITIALS_TOKEN = /^(?:\p{Lu}\.?(?:[-‐]\p{Lu}\.?)?){1,3}$/u;
// The authors' surnames as the entry lists them: { names, etAl }. The list is the text before the bracketed year, a
// quoted title or the parsed title; pieces are split at commas, semicolons, "&", "and", "и"; initials are dropped.
function ckEntryAuthors(entry) {
  const text = String(entry.text || '').replace(/^\s*(?:\[\d+\]|\d+[.)])\s*/, '');
  const ends = [/\(\s*(?:1[6-9]|20)\d\d/u.exec(text), /[“"«]/u.exec(text)].filter(Boolean).map((m) => m.index);
  if (entry.title) { const i = text.indexOf(entry.title); if (i > 0) ends.push(i); }
  let seg = text.slice(0, ends.length ? Math.min(...ends) : Math.min(text.length, 200));
  const etAl = /\bet al\b|\bи др\b/iu.test(seg);
  seg = seg.replace(/\bet al\.?|\bи др\.?/giu, ' ');
  const names = [];
  for (const piece of seg.split(/\s*(?:[,;&]|\band\b|\bи\b)\s*/u)) {
    const words = piece.trim().split(/\s+/).map((w) => w.replace(/[,:]+$/, '')).filter((w) => w && !CK_INITIALS_TOKEN.test(w));
    if (!words.length || words.length > 4 || !/\p{L}{2}/u.test(words.join(''))) continue;
    names.push(words.join(' ').replace(/\.$/, ''));
    if (names.length >= 30) break;
  }
  return { names, etAl };
}
// How the entry's authors match the work's: { matched (the longest run in the same order), of } or null when there is
// nothing beyond the first author to compare (fewer than two on either side). With "et al." only the listed ones count.
function ckAuthorMatch(entry, work) {
  const { names, etAl } = ckEntryAuthors(entry);
  const theirs = (work.authors || []).filter(Boolean);
  if (names.length < 2 || theirs.length < 2) return null;
  const ref = etAl ? theirs.slice(0, names.length) : theirs;
  const dp = Array.from({ length: names.length + 1 }, () => new Array(ref.length + 1).fill(0));
  for (let i = 1; i <= names.length; i++) {
    for (let j = 1; j <= ref.length; j++) {
      dp[i][j] = ckSameSurname(names[i - 1], ref[j - 1]) ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return { matched: dp[names.length][ref.length], of: etAl ? names.length : Math.max(names.length, theirs.length) };
}

// ---- Venues --------------------------------------------------------------------------------------------------------------
const CK_VENUE_STOP = new Set(['the', 'of', 'and', 'for', 'in', 'on', 'an', 'und', 'fur', 'der', 'die', 'des', 'de', 'la', 'le', 'et', 'i']);
const ckVenueWords = (v) => ckNormName(htmlToText(v)).replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ')
  .filter((w) => w && !CK_VENUE_STOP.has(w) && (w.length > 1 || w === 'j'));
// Whether an abbreviated word stands for a full one: the same first letter and its letters in order ("natl" ->
// "national", "j" -> "journal", "zh" -> "zhurnal").
const ckAbbrevOf = (w, full) => w[0] === full[0] && (() => { let k = 0; for (const c of full) if (c === w[k]) k++; return k >= w.length; })();
// Each word of a matched by the next word of b, and every word of b used: "J. Am. Chem. Soc." = "Journal of the American
// Chemical Society", "Phys. Rev. Lett." = "Physical Review Letters"; "Nature" is not "Nature Communications".
function ckVenueCovers(a, b) {
  if (!a.length || a.length !== b.length) return false;
  return a.every((w, i) => w === b[i] || ckAbbrevOf(w, b[i]));
}
// Whether the entry's venue names the work's (any of its names: the container title and its short form).
function ckVenueMatches(entryVenue, workVenues) {
  const list = [].concat(workVenues || []).filter(Boolean);
  if (!entryVenue || !list.length) return true;
  const x = ckVenueWords(entryVenue);
  if (!x.length) return true;
  return list.some((v) => {
    const y = ckVenueWords(v);
    return ckTitleSimilarity(entryVenue, v) >= CK_TITLE_MATCH || ckVenueCovers(x, y) || ckVenueCovers(y, x);
  });
}

// ---- Preprints -----------------------------------------------------------------------------------------------------------
// The server of a preprint entry ('arXiv', 'bioRxiv', …) or '': by name, or by its DOI prefix (bioRxiv and medRxiv share
// 10.1101 with journals, so only their dated DOIs count).
const CK_PREPRINTS = [
  ['arXiv', /\barxiv\b|\b10\.48550\//i], ['bioRxiv', /\bbiorxiv\b/i], ['medRxiv', /\bmedrxiv\b/i], ['ChemRxiv', /\bchemrxiv\b|\b10\.26434\//i],
  ['SSRN', /\bssrn\b|\b10\.2139\/ssrn/i], ['bioRxiv or medRxiv', /\b10\.1101\/(?:19|20)\d\d\.\d\d\.\d\d\./],
];
function ckPreprint(entry) {
  const t = String((entry && entry.text) || '');
  const hit = CK_PREPRINTS.find(([, re]) => re.test(t));
  return hit ? hit[0] : '';
}

const ckSurnameOf = (name) => { const t = String(name || '').trim(); return t.includes(',') ? t.split(',')[0].trim() : t.split(/\s+/).pop(); };

// A work found in an index: { title, year, years (all dates it carries), first (first author's surname), authors, venue,
// doi, source: 'Crossref' | 'OpenAlex' }.
function ckFromCsl(m, source = 'Crossref') {
  const datesOf = (k) => (((m[k] || {})['date-parts'] || [[]])[0] || [])[0];
  const years = ['issued', 'published', 'published-print', 'published-online', 'created'].map(datesOf).filter(Boolean).map(String);
  const people = (m.author || m.editor || []).map((a) => a.family || a.literal || a.name || '').filter(Boolean);
  const title = Array.isArray(m.title) ? m.title[0] : m.title;
  const venue = Array.isArray(m['container-title']) ? m['container-title'][0] : m['container-title'];
  const short = [].concat(m['container-title-short'] || m['short-container-title'] || []);
  return { title: String(title || ''), year: years[0] || '', years, first: people[0] || '', authors: people, venue: venue || '', venues: [venue, ...short].filter(Boolean),
    doi: String(m.DOI || '').toLowerCase(), source, csl: m };
}
function ckFromOpenAlex(w) {
  const people = (w.authorships || []).map((a) => ckSurnameOf((a.author || {}).display_name || a.raw_author_name || '')).filter(Boolean);
  const venue = ((w.primary_location || {}).source || {}).display_name || '';
  return { title: String(w.display_name || w.title || ''), year: w.publication_year ? String(w.publication_year) : '', years: w.publication_year ? [String(w.publication_year)] : [],
    first: people[0] || '', authors: people, venue, venues: venue ? [venue] : [], doi: String(w.doi || '').replace(/^https?:\/\/doi\.org\//i, '').toLowerCase(), source: 'OpenAlex' };
}
// Whether a found work is the entry's: by title, or (no title parsed) by the words of the whole entry.
const ckMatches = (entry, work) => (entry.title ? ckTitleSimilarity(entry.title, work.title) >= CK_TITLE_MATCH : false) || ckTitleCover(entry.text, work.title) >= CK_TITLE_MATCH;
// What differs between a matching work and the entry: [text].
function ckDifferences(entry, work) {
  const out = [];
  if (entry.year && work.years.length && !work.years.includes(entry.year)) out.push(`year ${entry.year} here, ${work.year} in ${work.source}`);
  if (entry.surname && work.first && !ckSameName(entry.surname, work.first) && !work.authors.slice(0, 3).some((a) => ckSameName(a, entry.surname))) {
    out.push(`first author ${entry.surname} here, ${work.first} in ${work.source}`);
  } else {
    const am = ckAuthorMatch(entry, work);
    if (am && am.matched / am.of < CK_AUTHOR_MATCH) out.push(`only ${am.matched} of ${am.of} authors match ${work.source} in the same order`);
  }
  if (entry.venue && !ckVenueMatches(entry.venue, work.venues || [work.venue])) out.push(`journal «${entry.venue}» here, «${work.venue}» in ${work.source}`);
  return out;
}
const ckWorkLabel = (w) => `«${w.title.length > 80 ? w.title.slice(0, 79) + '…' : w.title}» (${w.first || 'no author'}, ${w.year || 'no year'})`;

// The verdict of one entry from what the lookups found: { verdict: 'ok' | 'error' | 'warning' | 'unverified' | 'suspect',
// text }. found: { doiWork, doiMissing, doiError, hits: [work], searched: ['OpenAlex', 'Crossref'], venueKnown (true,
// false or null when not asked), failed (a lookup failed: its message) }.
function ckVerdict(entry, found) {
  const f = found || {};
  if (f.doiWork) {
    const w = f.doiWork;
    if (!ckMatches(entry, w)) return { verdict: 'error', text: `The DOI resolves to another work: ${ckWorkLabel(w)}.` };
    const diff = ckDifferences(entry, w);
    return diff.length ? { verdict: 'warning', text: `Matches Crossref by DOI, but ${diff.join('; ')}.` } : { verdict: 'ok', text: 'Matches Crossref by DOI.' };
  }
  const hit = (f.hits || []).find((w) => ckMatches(entry, w));
  const doiNote = f.doiMissing ? `Crossref does not know the DOI ${entry.doi}` : '';
  if (hit) {
    const diff = ckDifferences(entry, hit);
    if (doiNote) diff.unshift(doiNote.charAt(0).toLowerCase() + doiNote.slice(1) + (hit.doi ? ` (${hit.source} gives ${hit.doi})` : ''));
    return diff.length ? { verdict: 'warning', text: `Found in ${hit.source}, but ${diff.join('; ')}.` } : { verdict: 'ok', text: `Found in ${hit.source}.` };
  }
  const where = (f.searched || []).join(' or ') || 'the indexes';
  const lead = doiNote ? `${doiNote}, and the work is not found in ${where}` : `Not found in ${where}`;
  if (f.failed) return { verdict: 'unverified', text: `${lead}: a lookup failed (${f.failed}).` };
  if (entry.notIndexed) return { verdict: 'unverified', text: `${lead}: books, theses, preprints and reports are often not indexed; check it by hand.` };
  if ((f.searched || []).length >= 2 && f.venueKnown === false && entry.venue) {
    return { verdict: 'suspect', text: `${lead}, and OpenAlex does not know the journal «${entry.venue}». Check that this work exists.` };
  }
  if (f.venueKnown && entry.venue) return { verdict: 'unverified', text: `${lead}; the journal «${entry.venue}» is indexed, so check the title, authors and year.` };
  return { verdict: 'unverified', text: `${lead}; check it by hand.` };
}

// ---- Requests ----------------------------------------------------------------------------------------------------------
const ckAbortError = () => { const e = new Error('Stopped'); e.name = 'AbortError'; return e; };
function ckSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(ckAbortError()); return; }
    const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', stop); resolve(); }, ms);
    const stop = () => { clearTimeout(t); reject(ckAbortError()); };
    if (signal) signal.addEventListener('abort', stop, { once: true });
  });
}
// Settles with the promise, or rejects at once when the signal fires.
function ckRace(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(ckAbortError()); return; }
    const stop = () => reject(ckAbortError());
    signal.addEventListener('abort', stop, { once: true });
    promise.then((v) => { signal.removeEventListener('abort', stop); resolve(v); }, (e) => { signal.removeEventListener('abort', stop); reject(e); });
  });
}
async function ckGetJson(url, signal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CK_REF_TIMEOUT_MS);
  const stop = () => ctrl.abort();
  if (signal) signal.addEventListener('abort', stop, { once: true });
  let resp;
  try {
    resp = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
  } catch (e) {
    if (signal && signal.aborted) throw ckAbortError();
    throw new Error(ctrl.signal.aborted ? 'no answer in time' : (e && e.message) || String(e));
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', stop);
  }
  if (!resp.ok) throw new Error(`HTTP ${resp.status}${resp.status === 429 ? ' (too many requests)' : ''}`);
  try { return typeof resp.json === 'function' ? await resp.json() : JSON.parse(await resp.text()); } catch (e) { throw new Error('not valid JSON'); }
}
const ckQuery = (entry) => [entry.title || entry.text.slice(0, 200), entry.surname].filter(Boolean).join(' ').slice(0, 300);
async function ckOpenAlexSearch(entry, signal) {
  const url = `${OPENALEX_URL}/works?search=${encodeURIComponent(ckQuery(entry))}&per-page=5&select=id,doi,display_name,publication_year,authorships,primary_location`;
  const data = await ckGetJson(url, signal);
  return (data.results || []).map(ckFromOpenAlex);
}
async function ckCrossrefSearch(entry, signal) {
  const url = `${CROSSREF_URL}/works?query.bibliographic=${encodeURIComponent(ckQuery(entry))}&rows=5&select=DOI,title,author,issued,published,container-title,short-container-title,volume,issue,page`;
  const data = await ckGetJson(url, signal);
  return (((data.message || {}).items) || []).map((m) => ckFromCsl(m));
}
// Whether OpenAlex knows the venue (a source with a similar name).
async function ckVenueKnown(venue, signal) {
  const data = await ckGetJson(`${OPENALEX_URL}/sources?search=${encodeURIComponent(venue)}&per-page=5&select=display_name,alternate_titles,abbreviated_title`, signal);
  return (data.results || []).some((s) => [s.display_name, s.abbreviated_title, ...(s.alternate_titles || [])].filter(Boolean)
    .some((n) => ckTitleSimilarity(n, venue) >= CK_TITLE_MATCH));
}

// One entry: the lookups, then ckVerdict. io: { signal, openAlex (allowed), pause() (before every request but the
// first of the run) }.
async function ckCheckEntry(entry, io = {}) {
  const pre = ckPreprint(entry);
  if (pre) return { verdict: 'unverified', text: `Preprint (${pre}): not peer-reviewed, so not checked; look for a published version.`, work: null, preprint: true };
  const found = { searched: [], hits: [] };
  const ask = async (fn) => { await io.pause(); return fn(); };
  const failed = (e) => { if (e && e.name === 'AbortError') throw e; found.failed = found.failed || (e && e.message) || String(e); };
  if (entry.doi) {
    try {
      found.doiWork = ckFromCsl(await ask(() => ckRace(crossrefMeta(entry.doi), io.signal)));
      return { ...ckVerdict(entry, found), work: found.doiWork };
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      if (e && e.notFound) found.doiMissing = true; else failed(e);
    }
    if (!found.doiMissing) return ckVerdict(entry, found);
  }
  if (io.openAlex) {
    found.searched.push('OpenAlex');
    try { found.hits.push(...await ask(() => ckOpenAlexSearch(entry, io.signal))); } catch (e) { failed(e); }
  }
  if (!found.hits.some((w) => ckMatches(entry, w))) {
    found.searched.push('Crossref');
    try { found.hits.push(...await ask(() => ckCrossrefSearch(entry, io.signal))); } catch (e) { failed(e); }
  }
  const hit = found.hits.find((w) => ckMatches(entry, w));
  if (!hit && !found.failed && !entry.notIndexed && io.openAlex && entry.venue) {
    try { found.venueKnown = await ask(() => ckVenueKnown(entry.venue, io.signal)); } catch (e) { failed(e); }
  }
  return { ...ckVerdict(entry, found), work: hit || null };
}

// All entries (at most CK_REF_MAX), one at a time: [{ entry, verdict, text }]. opts: { signal, openAlex, delay,
// onProgress(done, total) }. A Stop ends the run with what is done (result.stopped).
async function ckVerifyReferences(entries, { signal = null, openAlex = false, delay = CK_REF_DELAY_MS, onProgress = () => {} } = {}) {
  const list = entries.slice(0, CK_REF_MAX);
  const results = [];
  let first = true;
  const pause = async () => { if (!first) await ckSleep(delay, signal); first = false; };
  try {
    for (let i = 0; i < list.length; i++) {
      onProgress(i, list.length);
      const r = await ckCheckEntry(list[i], { signal, openAlex, pause });
      results.push({ entry: list[i], ...r });
    }
    onProgress(list.length, list.length);
  } catch (e) {
    if (!(e && e.name === 'AbortError')) throw e;
    results.stopped = true;
  }
  results.skipped = Math.max(0, entries.length - list.length);
  return results;
}

// Whether Chrome grants the OpenAlex origin (part of the References grant; checked again, as access to one site can be
// removed in chrome://extensions).
async function ckOpenAlexAllowed() {
  try { return !!(await chrome.permissions.contains({ origins: [OPENALEX_URL + '/*'] })); } catch (e) { return false; }
}

// ---- A Crossref record as a plain-text entry (/check: Replace with the Crossref record) ---------------------------------
// The document's dominant style: 'numeric' when most entries carry a number ([3], 3., a numbered list), else 'author-year'
// (also the fallback: APA-like).
function ckCitationStyle(entries) {
  const list = entries || [];
  const numbered = list.filter((e) => e.n != null).length;
  return numbered && numbered * 2 > list.length ? 'numeric' : 'author-year';
}
// The number written at the start of an entry's line ("[3] ", "3. ", "3) "), kept by the replacement; '' for none.
const ckEntryPrefix = (text) => ((/^\s*(?:\[\d+\]|\d+[.)])\s*/.exec(String(text || '')) || [''])[0]);
const ckInitials = (given, dots) => String(given || '').split(/[\s.]+/).filter(Boolean)
  .map((g) => g.split('-').map((p) => p.charAt(0).toUpperCase() + (dots ? '.' : '')).join('-')).join(dots ? ' ' : '');
// The record as one line, without a number: numeric (Vancouver-like) "Smith J, Lee KM. Title. Journal. 2020;12(3):45-67.
// doi:10.…" (six authors, then "et al."), author-year (APA-like) "Smith, J., & Lee, K. M. (2020). Title. Journal, 12(3),
// 45–67. https://doi.org/10.…" (up to 20 authors). m: Crossref's CSL-JSON.
function ckFormatCsl(m, style = 'author-year') {
  const first = (v) => (Array.isArray(v) ? v[0] : v) || '';
  const clean = (t) => htmlToText(String(t || '')).replace(/\s+/g, ' ').trim();
  const people = (m.author && m.author.length ? m.author : m.editor || []).map((a) => ({ family: clean(a.family || a.literal || a.name || ''), given: clean(a.given || '') })).filter((a) => a.family);
  const parts = ((m.issued || m.published || m['published-print'] || m['published-online'] || {})['date-parts'] || [[]])[0] || [];
  const year = parts[0] ? String(parts[0]) : '';
  const title = clean(first(m.title)).replace(/[.\s]+$/, '');
  const venue = clean(first(m['container-title']));
  const { volume = '', issue = '', page = '' } = m;
  const doi = String(m.DOI || '').toLowerCase();
  const end = (t) => (/[.?!]$/.test(t) ? t : t + '.');
  if (style === 'numeric') {
    const names = people.slice(0, 6).map((a) => `${a.family}${a.given ? ' ' + ckInitials(a.given, false) : ''}`);
    const who = names.length ? names.join(', ') + (people.length > 6 ? ', et al' : '') : '';
    const where = [venue, [year, volume ? `${volume}${issue ? `(${issue})` : ''}` : ''].filter(Boolean).join(';') + (page ? `:${page}` : '')].filter(Boolean);
    return [who && end(who), title && end(title), ...where.map(end), doi && `doi:${doi}`].filter(Boolean).join(' ');
  }
  const names = people.slice(0, 20).map((a) => `${a.family}${a.given ? ', ' + ckInitials(a.given, true) : ''}`);
  const who = names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')}, ${people.length > 20 ? '…' : '&'} ${names[names.length - 1]}`;
  const src = venue ? `${venue}${volume ? `, ${volume}${issue ? `(${issue})` : ''}` : ''}${page ? `, ${String(page).replace(/-/g, '–')}` : ''}` : '';
  return [who && end(who), `(${year || 'n.d.'}).`, title && end(title), src && end(src), doi && `https://doi.org/${doi}`].filter(Boolean).join(' ');
}

// ---- The reading tool check_references ----------------------------------------------------------------------------------
const CK_TOOL_LABEL = { ok: 'Match', error: 'Error', warning: 'Warning', unverified: 'Unverified', suspect: 'Suspect' };
// The tool's text: a summary line, then one line per entry: "[3] Smith (2020), line 12: Warning: Found in Crossref, but …".
function ckReferencesText(results, total) {
  const ok = results.filter((r) => r.verdict === 'ok').length;
  const head = `${ok} of ${results.length} reference entr${results.length === 1 ? 'y matches' : 'ies match'} Crossref or OpenAlex` +
    (results.stopped ? ` (stopped after ${results.length} of ${Math.min(total, CK_REF_MAX)})` : '') +
    (total > CK_REF_MAX ? `; ${total - CK_REF_MAX} more not checked (at most ${CK_REF_MAX})` : '') + '.';
  const rows = results.map((r) => {
    const e = r.entry;
    const who = `${e.n != null ? `[${e.n}] ` : ''}${e.surname || String(e.text).slice(0, 30)}${e.year ? ` (${e.year})` : ''}`;
    return `${who}, line ${e.l ? e.l.line : '?'}: ${CK_TOOL_LABEL[r.verdict]}: ${r.text}`;
  });
  return [head, ...rows].join('\n');
}
// The reference list of the document as the turn started (the reading tools never see this turn's writes), checked
// like /check does.
async function runCheckReferences(name, args, snap) {
  const view = { ...snap, ...(snap.promptView || {}) };
  if (view.docText == null) return `Error: the document text is unavailable (${view.docError || 'export failed'}).`;
  const model = view.docFormat === 'docs-api' ? view.model : null;
  const entries = ckEntries(ckDocument(model ? { model } : { text: view.docText, format: view.docFormat }));
  if (!entries.length) return { content: 'No reference list found: no entries under a heading such as "References", "Bibliography" or "Список литературы".', _ok: true, _message: 'no reference list' };
  const openAlex = await ckOpenAlexAllowed();
  const results = await ckVerifyReferences(entries, {
    signal: snap.signal || null, openAlex,
    onProgress: (done, total) => { if (done < total) setStatus(`Checking reference ${done + 1} of ${total}…`); },
  });
  const note = openAlex ? '' : '\nOpenAlex is not allowed, so only Crossref was searched.';
  return { content: ckReferencesText(results, entries.length) + note, _ok: true, _message: `${results.length} entr${results.length === 1 ? 'y' : 'ies'} checked` };
}
const CHECK_REFERENCES_DEF = { type: 'function', function: {
  name: 'check_references',
  description: 'Check the reference list of the main document against Crossref and OpenAlex, as /check does: one line per entry (at most 50) with its verdict (Match, Error, Warning, Suspect, Unverified) and the reason. Slow (one lookup at a time); use it when the user asks whether the references are correct or real.',
  parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
} };
registerTools([CHECK_REFERENCES_DEF], {
  offer: (mode, snap) => refsOffered(snap) && (mode === 'edit' || mode === 'manual' || mode === 'plan') && offersOpenDocument(mode, snap),
  reading: true, icon: '📚',
  summary: () => 'the reference list',
  run: (name, args, snap, ui) => withReferences(snap, ui, 'To check the reference list.', () => runCheckReferences(name, args, snap)),
  prompt: [{ section: 'reading', line: '- check_references(): check the reference list against Crossref and OpenAlex (a verdict per entry; slow).' }],
});
