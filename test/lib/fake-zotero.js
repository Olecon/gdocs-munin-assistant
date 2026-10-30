'use strict';
// A fake Zotero 7 local API (localhost:23119/api/users/0) and a fake Crossref (api.crossref.org/v1/works/{doi}/transform)
// for the references tests. fetch(url, init) answers their URLs (null for others). Like the real Zotero, a request
// without "Zotero-Allowed-Request" is dropped silently (it hangs until aborted). z.running false: connection refused;
// z.apiOn false: HTTP 403. Every call is logged in z.calls ({ url, headers }).

const resp = (status, body, type = 'application/json') => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (k) => (k.toLowerCase() === 'content-type' ? type : null) },
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

// The library: key -> { data, apa: { citation, bib }, ieee: { citation, bib } } (HTML as Zotero sends it).
const LIBRARY = {
  ABCD1234: {
    data: { key: 'ABCD1234', itemType: 'journalArticle', title: 'Lipid rafts in membranes', date: '2020-03-01', publicationTitle: 'Biophysical Journal', DOI: '10.1016/j.bpj.2020.01.001',
      creators: [{ creatorType: 'author', lastName: 'Smith', firstName: 'John' }, { creatorType: 'author', lastName: 'Lee', firstName: 'Kim' }] },
    apa: { citation: '<span>(Smith &amp; Lee, 2020)</span>', bib: '<div class="csl-bib-body"><div class="csl-entry">Smith, J., &amp; Lee, K. (2020). Lipid rafts in membranes. <i>Biophysical Journal</i>.</div></div>' },
    ieee: { citation: '<span>[1]</span>', bib: '<div class="csl-bib-body"><div class="csl-entry"><div class="csl-left-margin">[1]</div><div class="csl-right-inline">J. Smith and K. Lee, “Lipid rafts in membranes,” <i>Biophys. J.</i>, 2020.</div></div></div>' },
  },
  EFGH5678: {
    data: { key: 'EFGH5678', itemType: 'book', title: 'Cholesterol and order', date: '2018', publisher: 'Springer',
      creators: [{ creatorType: 'author', lastName: 'Brown', firstName: 'Ann Marie' }] },
    apa: { citation: '<span>(Brown, 2018)</span>', bib: '<div class="csl-bib-body"><div class="csl-entry">Brown, A. M. (2018). <i>Cholesterol and order</i>. Springer.</div></div>' },
    ieee: { citation: '<span>[1]</span>', bib: '<div class="csl-bib-body"><div class="csl-entry"><div class="csl-left-margin">[1]</div><div class="csl-right-inline">A. M. Brown, <i>Cholesterol and order</i>. Springer, 2018.</div></div></div>' },
  },
  NOTE0001: { data: { key: 'NOTE0001', itemType: 'note', note: 'Smith notes', creators: [] } },
};

// Crossref: doi -> { meta (CSL-JSON), apa, ieee (text/x-bibliography) }.
const CROSSREF = {
  '10.1038/nphys1234': {
    meta: { DOI: '10.1038/nphys1234', title: 'Membrane physics', 'container-title': 'Nature Physics', author: [{ family: 'Doe', given: 'Jane' }, { family: 'Roe', given: 'Rick' }, { family: 'Poe', given: 'Pat' }], issued: { 'date-parts': [[2019, 5]] } },
    apa: 'Doe, J., Roe, R., &amp; Poe, P. (2019). Membrane physics. <i>Nature Physics</i>. https://doi.org/10.1038/nphys1234',
    ieee: '[1]J. Doe, R. Roe, and P. Poe, “Membrane physics,” Nature Physics, 2019.',
  },
};

function fakeZotero() {
  const z = { calls: [], running: true, apiOn: true, crossrefCalls: [] };
  z.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://api.crossref.org/')) return crossref(z, u, init);
    if (!u.startsWith('http://localhost:23119/')) return null;
    z.calls.push({ url: u, headers: { ...(init.headers || {}) } });
    if (!z.running) throw new TypeError('Failed to fetch');
    if (!init.headers || init.headers['Zotero-Allowed-Request'] !== '1') {
      return new Promise((_, reject) => { if (init.signal) init.signal.addEventListener('abort', () => reject(new Error('The operation was aborted.'))); });
    }
    if (!z.apiOn) return resp(403, 'Local API is not enabled', 'text/plain');
    const parsed = new URL(u);
    if (!parsed.pathname.startsWith('/api/users/0/items')) return resp(404, 'Not found', 'text/plain');
    const q = parsed.searchParams;
    if (q.get('format') === 'keys') return resp(200, Object.keys(LIBRARY).slice(0, Number(q.get('limit')) || 25).join('\n'), 'text/plain');
    const style = q.get('style') || 'chicago-note-bibliography';
    const include = (q.get('include') || '').split(',');
    const out = (key) => {
      const it = LIBRARY[key];
      const o = { key, version: 1, data: it.data };
      const f = it[style];
      if (include.includes('citation')) o.citation = f ? f.citation : '';
      if (include.includes('bib')) o.bib = f ? f.bib : '';
      return o;
    };
    if (q.get('itemKey')) return resp(200, q.get('itemKey').split(',').filter((k) => LIBRARY[k]).map(out));
    const needle = String(q.get('q') || '').toLowerCase();
    const words = needle.split(/\s+/).filter(Boolean);
    const hay = (d) => [d.title, d.date, ...(d.creators || []).map((c) => c.lastName), ...(q.get('qmode') === 'everything' ? [d.DOI, d.note] : [])].join(' ').toLowerCase();
    return resp(200, Object.keys(LIBRARY).filter((k) => words.every((w) => hay(LIBRARY[k].data).includes(w))).map(out));
  };
  return z;
}

function crossref(z, u, init) {
  const accept = (init.headers && init.headers.Accept) || '';
  z.crossrefCalls.push({ url: u, accept });
  const m = /^https:\/\/api\.crossref\.org\/v1\/works\/(.+)\/transform$/.exec(u);
  const doi = m ? m[1].split('/').map(decodeURIComponent).join('/') : '';
  const rec = CROSSREF[doi];
  if (!rec) return resp(404, 'Resource not found.', 'text/plain');
  if (accept === 'application/vnd.citationstyles.csl+json') return resp(200, rec.meta);
  const style = (/style=([\w-]+)/.exec(accept) || [])[1];
  return resp(200, rec[style] || rec.apa, 'text/plain');
}

module.exports = { fakeZotero, LIBRARY, CROSSREF, resp };
