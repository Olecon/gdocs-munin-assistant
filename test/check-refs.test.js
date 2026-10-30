'use strict';
// /check's reference-list check (src/check-refs.js) on fake Crossref and OpenAlex responses: the verdicts Error (the DOI
// resolves to another work), Warning (year or first author), Unverified (no hit; books and theses; a failed lookup),
// Suspect (no hit in both sources, the venue unknown), the order and spacing of the requests, the 50-entry cap and Stop.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { load, deq } = require('./lib/sandbox');

let T, ctx;
before(async () => { ({ T, ctx } = await load({ settle: 0 })); });

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
const csl = (title, family, year, doi = '10.1000/x') => ({ title, author: [{ family, given: 'A.' }], issued: { 'date-parts': [[year]] }, DOI: doi });
const oaWork = (title, name, year, doi = null) => ({ display_name: title, publication_year: year, authorships: [{ author: { display_name: name } }], primary_location: { source: { display_name: '' } }, doi });
// A fake network: routes[] = [regex, response or fn(url)]; every URL asked is logged.
function network(routes) {
  const log = [];
  ctx.fetch = async (url) => {
    log.push(String(url));
    for (const [re, r] of routes) if (re.test(String(url))) return typeof r === 'function' ? r(String(url)) : r;
    throw new Error('unexpected fetch ' + url);
  };
  return log;
}
const entry = (text) => T.ckParseEntry(text);
const verify = (entries, opts = {}) => T.ckVerifyReferences(entries, { openAlex: true, delay: 0, ...opts });

test('title similarity: normalized, a subtitle or punctuation does not matter, another work does', () => {
  assert.strictEqual(T.ckTitleSimilarity('Lipid rafts in membranes', 'Lipid Rafts in Membranes.'), 1);
  assert.ok(T.ckTitleSimilarity('Lipid rafts in membranes', 'Lipid rafts in membranes: a review of the evidence') >= 0.8);
  assert.ok(T.ckTitleSimilarity('Lipid rafts in membranes', 'Deep learning for protein folding') < 0.5);
  assert.ok(T.ckTitleSimilarity('Ионный обмен на цеолитах Сибири', 'Ионный обмен на цеолитах сибири') === 1);
});

test('ckVerdict: matching DOI, another work, year and author mismatches, the not-found cases', () => {
  const e = entry('Smith J. (2020). Lipid rafts in membranes. Cell Biology 4, 1–9. doi:10.1000/x');
  const w = (title, first, year) => ({ title, first, authors: [first], year: String(year), years: [String(year)], venue: '', doi: '10.1000/x', source: 'Crossref' });
  deq(T.ckVerdict(e, { doiWork: w('Lipid rafts in membranes', 'Smith', 2020) }).verdict, 'ok');
  const other = T.ckVerdict(e, { doiWork: w('Deep learning for protein folding', 'Jumper', 2021) });
  deq([other.verdict, other.text], ['error', 'The DOI resolves to another work: «Deep learning for protein folding» (Jumper, 2021).']);
  const year = T.ckVerdict(e, { doiWork: w('Lipid rafts in membranes', 'Smith', 2019) });
  deq([year.verdict, year.text], ['warning', 'Matches Crossref by DOI, but year 2020 here, 2019 in Crossref.']);
  const author = T.ckVerdict(e, { doiWork: w('Lipid rafts in membranes', 'Jones', 2020) });
  deq([author.verdict, author.text], ['warning', 'Matches Crossref by DOI, but first author Smith here, Jones in Crossref.']);
  const plain = entry('Doe J. (2019). Soil models of carbon. Soil Journal 3, 1–2.');
  deq(T.ckVerdict(plain, { searched: ['OpenAlex', 'Crossref'], hits: [], venueKnown: false }).verdict, 'suspect');
  deq(T.ckVerdict(plain, { searched: ['OpenAlex', 'Crossref'], hits: [], venueKnown: true }).verdict, 'unverified');
  deq(T.ckVerdict(plain, { searched: ['Crossref'], hits: [], venueKnown: null }).verdict, 'unverified'); // one source: never suspect
  const book = entry('Doe J. (2019). Soil models. PhD thesis, University of Leeds.');
  const v = T.ckVerdict(book, { searched: ['OpenAlex', 'Crossref'], hits: [], venueKnown: false });
  deq([v.verdict, /books, theses, preprints/.test(v.text), /fake/i.test(v.text)], ['unverified', true, false]);
});

test('a DOI entry: Crossref by DOI; Error when it resolves to another work, Warning on the year, OK otherwise', async () => {
  const log = network([
    [/works\/10\.1000\/good/, json(csl('Lipid rafts in membranes', 'Smith', 2020))],
    [/works\/10\.1000\/other/, json(csl('Deep learning for protein folding', 'Jumper', 2021))],
    [/works\/10\.1000\/late/, json({ ...csl('Interfacial activation of lipases', 'Okafor', 2022), 'published-online': { 'date-parts': [[2021]] } })],
    [/works\/10\.1000\/year/, json(csl('Soil respiration on slopes', 'Brandt', 2015))],
  ]);
  const res = await verify([
    entry('Smith J. (2020). Lipid rafts in membranes. Cell Biology 4, 1–9. https://doi.org/10.1000/good'),
    entry('Lee K. (2020). Lipid rafts in membranes. Cell Biology 4, 1–9. doi:10.1000/other'),
    entry('Okafor C. (2021). Interfacial activation of lipases. Protein 3, 1. doi:10.1000/late'),
    entry('Brandt K. (2011). Soil respiration on slopes. Soil 2, 4. doi:10.1000/year'),
  ]);
  deq(res.map((r) => r.verdict), ['ok', 'error', 'ok', 'warning']);
  assert.match(res[3].text, /year 2011 here, 2015 in Crossref/);
  assert.ok(log.every((u) => /^https:\/\/api\.crossref\.org\/v1\/works\/10\.1000\/\w+\/transform$/.test(u)), log.join('\n'));
});

test('an entry without a DOI: OpenAlex search first, Crossref second, then the venue; the four outcomes', async () => {
  const log = network([
    [/openalex\.org\/works\?search=Found/, json({ results: [oaWork('Found in OpenAlex here', 'Ann Smith', 2019)] })],
    [/openalex\.org\/works\?search=Late/, json({ results: [oaWork('Late in OpenAlex here', 'Ann Smith', 2021)] })],
    [/openalex\.org\/works\?search=/, json({ results: [oaWork('Something else entirely', 'Bob Jones', 2001)] })],
    [/crossref\.org\/works\?query\.bibliographic=Crossref/, json({ message: { items: [csl('Crossref only work title', 'Smith', 2019)] } })],
    [/crossref\.org\/works\?query\.bibliographic=/, json({ message: { items: [] } })],
    [/openalex\.org\/sources\?search=Known/, json({ results: [{ display_name: 'Known Journal', alternate_titles: [] }] })],
    [/openalex\.org\/sources\?search=/, json({ results: [{ display_name: 'A very different venue' }] })],
  ]);
  const res = await verify([
    entry('Smith A. (2019). Found in OpenAlex here. Some Journal 1, 2.'),
    entry('Smith A. (2019). Late in OpenAlex here. Some Journal 1, 2.'),
    entry('Smith A. (2019). Crossref only work title. Some Journal 1, 2.'),
    entry('Smith A. (2019). Missing everywhere. Known Journal 1, 2.'),
    entry('Smith A. (2019). Invented study of things. Fantasy Letters 1, 2.'),
    entry('Smith A. (2019). A book about soil. Oxford University Press.'),
  ]);
  deq(res.map((r) => r.verdict), ['ok', 'warning', 'ok', 'unverified', 'suspect', 'unverified']);
  assert.strictEqual(res[0].text, 'Found in OpenAlex.');
  assert.strictEqual(res[2].text, 'Found in Crossref.');
  assert.match(res[1].text, /^Found in OpenAlex, but year 2019 here, 2021 in OpenAlex\.$/);
  assert.match(res[3].text, /^Not found in OpenAlex or Crossref; the journal «Known Journal» is indexed/);
  assert.match(res[4].text, /^Not found in OpenAlex or Crossref, and OpenAlex does not know the journal «Fantasy Letters»\. Check that this work exists\.$/);
  assert.match(res[5].text, /books, theses, preprints/);
  // the requests: one entry after another; a found work asks no more; the venue only for a work found nowhere
  const kinds = log.map((u) => (/sources\?/.test(u) ? 'venue' : /openalex/.test(u) ? 'oa' : 'cr'));
  deq(kinds, ['oa', 'oa', 'oa', 'cr', 'oa', 'cr', 'venue', 'oa', 'cr', 'venue', 'oa', 'cr']);
  assert.ok(log[0].includes('select=') && log[0].includes('per-page=5'));
});

test('without the OpenAlex permission only Crossref is asked, and nothing is Suspect; a failed lookup is Unverified', async () => {
  let log = network([[/crossref\.org\/works\?query/, json({ message: { items: [] } })]]);
  let res = await verify([entry('Smith A. (2019). Invented study of things. Fantasy Letters 1, 2.')], { openAlex: false });
  deq([res[0].verdict, log.length], ['unverified', 1]);
  assert.match(res[0].text, /^Not found in Crossref; check it by hand\.$/);
  log = network([[/crossref/, json({}, 503)], [/openalex/, async () => { throw new Error('Failed to fetch'); }]]);
  res = await verify([entry('Smith A. (2019). Something. Journal 1, 2. doi:10.1000/x'), entry('Smith A. (2019). Other thing here. Journal 1, 2.')]);
  deq(res.map((r) => r.verdict), ['unverified', 'unverified']);
  assert.match(res[0].text, /a lookup failed \(Crossref answered HTTP 503\)/);
  assert.match(res[1].text, /a lookup failed \(Failed to fetch\)/);
  // a DOI Crossref does not know: searched like an entry without one
  network([[/v1\/works\/10\.9999/, json({}, 404)], [/openalex\.org\/works/, json({ results: [oaWork('Sodium pretreatment of zeolites', 'S. Lee', 2019, 'https://doi.org/10.5555/real')] })]]);
  res = await verify([entry('Lee S. (2019). Sodium pretreatment of zeolites. Materials 1, 2. doi:10.9999/wrong')]);
  deq(res[0].verdict, 'warning');
  assert.match(res[0].text, /crossref does not know the DOI 10\.9999\/wrong \(OpenAlex gives 10\.5555\/real\)/);
});

test('at most 50 entries, a pause between requests, progress, and Stop ends the run with what is done', async () => {
  network([[/crossref\.org\/works\?query/, json({ message: { items: [] } })]]);
  const many = Array.from({ length: 53 }, (_, i) => entry(`Smith A. (2019). Title number ${i}. Journal 1, 2.`));
  const progress = [];
  let res = await verify(many, { openAlex: false, onProgress: (d, n) => progress.push(`${d}/${n}`) });
  deq([res.length, res.skipped, progress[0], progress[progress.length - 1]], [50, 3, '0/50', '50/50']);
  assert.strictEqual(T.CK_REF_MAX, 50);
  const abort = new AbortController();
  let asked = 0;
  network([[/crossref/, () => { asked++; if (asked === 2) abort.abort(); return json({ message: { items: [] } }); }]]);
  res = await verify(many.slice(0, 5), { openAlex: false, signal: abort.signal, delay: 5 });
  deq([res.stopped, res.length], [true, 2]);
});
