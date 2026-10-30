'use strict';
// Module zotero.js: the transport of the references tools (src/references.js): Zotero 7's local API (read-only GET
// on localhost:23119/api, user 0: the probe zoteroStatus, zoteroSearch, zoteroFormat with Zotero's own citation
// and bibliography in a CSL style) and the Crossref fallback for DOIs (crossrefMeta, crossrefBib). Plain text out:
// htmlToText strips Zotero's HTML.
/* global CROSSREF_URL, ZOTERO_URL */
/* exported zoteroStatus, zoteroSearch, zoteroFormat, crossrefMeta, crossrefBib, parseDoi, htmlToText, itemSummary,
   cslSummary, resetZoteroStatus, ZOTERO_SETUP */

// Zotero drops a request from a browser (an Origin header or a Mozilla/ User-Agent) silently unless it carries
// this header; with it the local API answers like the web API v3.
const ZOTERO_HEADERS = { 'Zotero-Allowed-Request': '1', 'Zotero-API-Version': '3' };
const ZOTERO_PROBE_MS = 800; // a running Zotero answers at once; a refused connection fails even faster
const ZOTERO_TIMEOUT_MS = 15000; // a search or a bibliography of a large library
const CROSSREF_TIMEOUT_MS = 15000;
const ZOTERO_STATUS_TTL_MS = 60000;
const ZOTERO_SETUP = 'Zotero → Settings → Advanced → "Allow other applications on this computer to communicate with Zotero"';

// fetch with a time limit; a timeout rejects with err.timeout set.
async function fetchWithin(url, init, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    if (ctrl.signal.aborted) { const t = new Error('no answer in time'); t.timeout = true; throw t; }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const zoteroUrl = (path) => `${ZOTERO_URL}/api/users/0/${path}`;

// Whether Zotero's local API answers: { ok: true } or { ok: false, reason: 'absent' | 'off' | 'error', message }.
// Cached for a minute (a turn may search several times); a failed search clears the cache.
let zoteroCache = null;
const resetZoteroStatus = () => { zoteroCache = null; };
async function zoteroStatus() {
  if (zoteroCache && Date.now() - zoteroCache.at < ZOTERO_STATUS_TTL_MS) return zoteroCache.status;
  let status;
  try {
    const resp = await fetchWithin(zoteroUrl('items?limit=1&format=keys'), { headers: ZOTERO_HEADERS }, ZOTERO_PROBE_MS);
    if (resp.ok) status = { ok: true };
    // The local API setting off: Zotero answers 403 ("Local API is not enabled"); an older Zotero has no /api (404).
    else if (resp.status === 403 || resp.status === 404) status = { ok: false, reason: 'off', message: `HTTP ${resp.status}` };
    else status = { ok: false, reason: 'error', message: `HTTP ${resp.status}` };
  } catch (e) {
    status = { ok: false, reason: 'absent', message: e.message };
  }
  zoteroCache = { at: Date.now(), status };
  return status;
}

async function zoteroGet(path) {
  let resp;
  try {
    resp = await fetchWithin(zoteroUrl(path), { headers: ZOTERO_HEADERS }, ZOTERO_TIMEOUT_MS);
  } catch (e) {
    resetZoteroStatus();
    throw new Error(`Zotero did not answer (${e.message}); is it still running?`);
  }
  if (!resp.ok) {
    resetZoteroStatus();
    throw new Error(`Zotero answered HTTP ${resp.status}`);
  }
  return resp.json();
}

// Up to 10 regular items (no attachments or notes) matching q in titles, creators and years ('everything' also
// searches fields such as the DOI).
async function zoteroSearch(q, everything = false) {
  const qs = new URLSearchParams({ q, qmode: everything ? 'everything' : 'titleCreatorYear', limit: '25', format: 'json', include: 'data' });
  const items = await zoteroGet('items?' + qs.toString());
  return (Array.isArray(items) ? items : [])
    .filter((it) => it && it.data && !['attachment', 'note', 'annotation'].includes(it.data.itemType))
    .slice(0, 10);
}

// Zotero's own in-text citation and bibliography entry for each key in the CSL style: { KEY: { citation, bib,
// data, numbered } } as plain text (numbered: a numeric style; its entry number is dropped, the panel numbers the
// entries). Unknown keys are missing from the result.
async function zoteroFormat(keys, style, locale) {
  const out = {};
  for (let i = 0; i < keys.length; i += 50) { // itemKey takes up to 50 keys
    const qs = new URLSearchParams({ itemKey: keys.slice(i, i + 50).join(','), format: 'json', include: 'data,citation,bib', style, locale });
    const items = await zoteroGet('items?' + qs.toString());
    for (const it of Array.isArray(items) ? items : []) {
      if (!it || !it.key) continue;
      const citation = htmlToText(it.citation || '');
      const numbered = /csl-left-margin/.test(it.bib || '') || NUMERIC_CITATION_RE.test(citation);
      out[it.key] = { citation, bib: stripEntryNumber(htmlToText(dropLeftMargin(it.bib || ''))), data: it.data || {}, numbered };
    }
  }
  return out;
}

// ---- Crossref (DOIs) -----------------------------------------------------------------------------------
const crossrefUrl = (doi, transform) => `${CROSSREF_URL}/v1/works/${doi.split('/').map(encodeURIComponent).join('/')}${transform ? '/transform' : ''}`;
async function crossrefGet(doi, accept) {
  let resp;
  try {
    resp = await fetchWithin(crossrefUrl(doi, true), { headers: { Accept: accept } }, CROSSREF_TIMEOUT_MS);
  } catch (e) {
    throw new Error(`could not reach Crossref (${e.message}). Try again later`);
  }
  if (resp.status === 404) {
    const err = new Error(`Crossref does not know DOI "${doi}". Check the DOI; DOIs registered elsewhere (DataCite, mEDRA) are not supported`);
    err.notFound = true;
    throw err;
  }
  if (!resp.ok) throw new Error(`Crossref answered HTTP ${resp.status}${resp.status === 429 ? ' (too many requests; wait a minute)' : ''}`);
  return resp.text();
}
// The CSL-JSON metadata of a DOI ({ author: [{ family, given }], issued, title, 'container-title', DOI, ... }).
async function crossrefMeta(doi) {
  const text = await crossrefGet(doi, 'application/vnd.citationstyles.csl+json');
  try { return JSON.parse(text); } catch (e) { throw new Error('Crossref did not return valid metadata'); }
}
// The formatted bibliography entry of a DOI in the CSL style: { bib (plain text without its own number), numbered }.
async function crossrefBib(doi, style, locale) {
  const text = htmlToText(await crossrefGet(doi, `text/x-bibliography; style=${style}; locale=${locale}`));
  return { bib: stripEntryNumber(text), numbered: ENTRY_NUMBER_RE.test(text) };
}

// A DOI in the query ("10.1000/xyz", "doi:10.1000/xyz", "https://doi.org/10.1000/xyz"), lowercased, or null.
function parseDoi(q) {
  const m = /\b(10\.\d{4,9}\/[^\s"<>]+)/i.exec(String(q || ''));
  return m ? m[1].replace(/[.,;:)\]]+$/, '').toLowerCase() : null;
}

// ---- Plain text -----------------------------------------------------------------------------------------
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', ndash: '–', mdash: '—', hellip: '…' };
function htmlToText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ').trim(); // \s includes the no-break space
}
// Numeric styles put the entry number in a left-margin column.
const dropLeftMargin = (html) => String(html).replace(/<div class="csl-left-margin">[\s\S]*?<\/div>/g, '');
// An in-text citation of a numeric style: "[1]", "(1)", "1", "[1, 2]", "[1–3]".
const NUMERIC_CITATION_RE = /^[[(]?\d+(?:\s*[,–-]\s*\d+)*[\])]?$/;
// "[3] ", "[3]" (Crossref's IEEE has no space), "3. ", "(3) " at the start of an entry.
const ENTRY_NUMBER_RE = /^(?:\[\d+\]\s*|\d+\.\s+|\(\d+\)\s+)/;
const stripEntryNumber = (t) => String(t).replace(ENTRY_NUMBER_RE, '');

// ---- Compact listings -------------------------------------------------------------------------------------
const clip = (t, n) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const initials = (given) => String(given || '').split(/[\s-]+/).filter(Boolean).map((g) => g[0].toUpperCase() + '.').join(' ');
function namesText(people) {
  const names = people.map((p) => (p.family ? p.family + (p.given ? ', ' + initials(p.given) : '') : p.literal || '')).filter(Boolean);
  return names.length > 3 ? names.slice(0, 3).join('; ') + ' et al.' : names.join('; ');
}
// "Smith, J.; Lee, K. (2020). Title. Container. doi:…" of a Zotero item's data.
function itemSummary(d) {
  const people = (d.creators || []).filter((c) => !c.creatorType || ['author', 'editor', 'inventor', 'presenter', 'artist', 'director'].includes(c.creatorType))
    .map((c) => ({ family: c.lastName || '', given: c.firstName || '', literal: c.name || '' }));
  const year = (/\b(\d{4})\b/.exec(d.date || '') || [])[1] || 'n.d.';
  const container = d.publicationTitle || d.bookTitle || d.proceedingsTitle || d.websiteTitle || d.publisher || '';
  return `${namesText(people) || 'Anonymous'} (${year}). ${clip(d.title || 'Untitled', 120)}.${container ? ' ' + clip(container, 60) + '.' : ''}${d.DOI ? ' doi:' + d.DOI : ''}`;
}
// The same from Crossref's CSL-JSON.
function cslSummary(m) {
  const people = (m.author || m.editor || []).map((a) => ({ family: a.family || '', given: a.given || '', literal: a.literal || a.name || '' }));
  const parts = ((m.issued || m.published || {})['date-parts'] || [[]])[0] || [];
  const container = Array.isArray(m['container-title']) ? m['container-title'][0] : m['container-title'];
  const title = Array.isArray(m.title) ? m.title[0] : m.title;
  return `${namesText(people) || 'Anonymous'} (${parts[0] || 'n.d.'}). ${clip(title || 'Untitled', 120)}.${container ? ' ' + clip(container, 60) + '.' : ''}`;
}
