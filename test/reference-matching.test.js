'use strict';
// The reference-list follow-ups (src/check-refs.js): author matching by normalized surnames (diacritics, particles,
// hyphens; at least 60% of the authors in the same order), venue matching with common abbreviations, preprints as
// Unverified without a lookup, the plain-text entry written from a Crossref record (numeric and author-year), the
// dominant style, and the reading tool check_references (its offer and its text).
const { test, before } = require('node:test');
const assert = require('node:assert');
const { load, deq, makeSnapFor } = require('./lib/sandbox');

let env, T, ctx, state, snapFor;
before(async () => { env = await load({ settle: 0 }); ({ T, ctx, state } = env); snapFor = makeSnapFor(env); });

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
const entry = (text) => T.ckParseEntry(text);
const work = (authors, extra = {}) => ({ title: 'Lipid rafts in membranes', first: authors[0], authors, year: '2020', years: ['2020'], venue: '', venues: [], doi: '10.1000/x', source: 'Crossref', ...extra });

test('surnames: diacritics folded, particles dropped, a double surname by one part, ё and й', () => {
  assert.ok(T.ckSameSurname('Müller', 'Muller'));
  assert.ok(T.ckSameSurname('van der Waals', 'Waals'));
  assert.ok(T.ckSameSurname('De Vries', 'de Vries'));
  assert.ok(T.ckSameSurname('García-Márquez', 'Garcia Marquez'));
  assert.ok(T.ckSameSurname('García-Márquez', 'García'));
  assert.ok(T.ckSameSurname('Пётр', 'Петр'));
  assert.ok(!T.ckSameSurname('Smith', 'Smyth'));
  assert.ok(!T.ckSameSurname('van der Berg', 'van der Waals'));
});

test('the author list of an entry: APA, Vancouver, IEEE, Russian; "et al."', () => {
  deq(T.ckEntryAuthors(entry('Smith, J., Lee, K. M., & van der Waals, J. D. (2020). Lipid rafts in membranes. Cell 4, 1–9.')), { names: ['Smith', 'Lee', 'van der Waals'], etAl: false });
  deq(T.ckEntryAuthors(entry('[3] Smith J, Lee KM, Brown A, et al. Lipid rafts in membranes. Cell. 2020;4:1-9.')), { names: ['Smith', 'Lee', 'Brown'], etAl: true });
  deq(T.ckEntryAuthors(entry('J. Smith, K. Lee, and A. Brown, “Lipid rafts in membranes,” Cell, vol. 4, 2020.')), { names: ['Smith', 'Lee', 'Brown'], etAl: false });
  deq(T.ckEntryAuthors(entry('Иванов И. И., Петров П. П. (2019). Ионный обмен на цеолитах. Журнал 3, 1–2.')).names, ['Иванов', 'Петров']);
});

test('authors beyond the first: at least 60% in the same order, else a Warning; et al. compares the listed ones', () => {
  const e = entry('Smith, J., Lee, K., Brown, A., & Okafor, C. (2020). Lipid rafts in membranes. Cell 4, 1–9.');
  deq(T.ckAuthorMatch(e, work(['Smith', 'Lee', 'Brown', 'Okafor'])), { matched: 4, of: 4 });
  deq(T.ckAuthorMatch(e, work(['Smith', 'Jones', 'Patel', 'Okafor', 'Kim'])), { matched: 2, of: 5 });
  assert.strictEqual(T.ckAuthorMatch(entry('Smith, J. (2020). Lipid rafts in membranes. Cell 4.'), work(['Smith', 'Lee'])), null); // one author: nothing more
  const etAl = entry('Smith J, Lee K, Brown A, et al. Lipid rafts in membranes. Cell. 2020;4:1-9.');
  deq(T.ckAuthorMatch(etAl, work(['Smith', 'Lee', 'Brown', 'Okafor', 'Kim', 'Wu'])), { matched: 3, of: 3 });
  const ok = T.ckVerdict(e, { doiWork: work(['Smith', 'Lee', 'Brown', 'Okafor']) });
  assert.strictEqual(ok.verdict, 'ok');
  const bad = T.ckVerdict(e, { doiWork: work(['Smith', 'Jones', 'Patel', 'Okafor', 'Kim']) });
  deq([bad.verdict, bad.text], ['warning', 'Matches Crossref by DOI, but only 2 of 5 authors match Crossref in the same order.']);
  // 3 of 5 in order (60%): enough
  assert.strictEqual(T.ckVerdict(e, { doiWork: work(['Smith', 'Lee', 'Patel', 'Okafor', 'Kim']) }).verdict, 'ok');
});

test('venues: abbreviations (J., Phys., Chem., Rev., Lett., Proc., Int., Zh.) and short titles; another journal is a Warning', () => {
  assert.ok(T.ckVenueMatches('J. Am. Chem. Soc.', ['Journal of the American Chemical Society']));
  assert.ok(T.ckVenueMatches('Phys. Rev. Lett.', ['Physical Review Letters']));
  assert.ok(T.ckVenueMatches('Proc. Natl. Acad. Sci. U.S.A.', ['Proceedings of the National Academy of Sciences']));
  assert.ok(T.ckVenueMatches('Int. J. Mol. Sci.', ['International Journal of Molecular Sciences']));
  assert.ok(T.ckVenueMatches('Chem. Rev.', ['Chemical Reviews']));
  assert.ok(T.ckVenueMatches('Zh. Fiz. Khim.', ['Zhurnal Fizicheskoi Khimii']));
  assert.ok(T.ckVenueMatches('Journal of Catalysis', ['Journal of Catalysis', 'J. Catal.']));
  assert.ok(T.ckVenueMatches('J Catal', ['Journal of Catalysis']));
  assert.ok(!T.ckVenueMatches('Nature', ['Nature Communications']));
  assert.ok(!T.ckVenueMatches('Phys. Rev. B', ['Physical Review Letters']));
  assert.ok(T.ckVenueMatches('', ['Anything']) && T.ckVenueMatches('Cell', []));
  const e = entry('Smith, J. (2020). Lipid rafts in membranes. Nature 4, 1–9.');
  const v = T.ckVerdict(e, { doiWork: work(['Smith'], { venue: 'Nature Communications', venues: ['Nature Communications', 'Nat Commun'] }) });
  deq([v.verdict, v.text], ['warning', 'Matches Crossref by DOI, but journal «Nature» here, «Nature Communications» in Crossref.']);
});

test('preprints (arXiv, bioRxiv, medRxiv, ChemRxiv, SSRN, their DOIs) are Unverified with the note "preprint", without a lookup', async () => {
  for (const [text, server] of [
    ['Lee K. (2023). Large models. arXiv:2301.01234.', 'arXiv'],
    ['Lee K. (2023). Large models. https://doi.org/10.48550/arXiv.2301.01234', 'arXiv'],
    ['Lee K. (2021). Cells. bioRxiv 2021.03.01.433000.', 'bioRxiv'],
    ['Lee K. (2021). Cells. medRxiv.', 'medRxiv'],
    ['Lee K. (2022). Zeolites. ChemRxiv. doi:10.26434/chemrxiv-2022-abc', 'ChemRxiv'],
    ['Lee K. (2020). Markets. SSRN Electronic Journal.', 'SSRN'],
    ['Lee K. (2020). Cells. doi:10.1101/2020.03.12.123456', 'bioRxiv or medRxiv'],
  ]) assert.strictEqual(T.ckPreprint(entry(text)), server, text);
  assert.strictEqual(T.ckPreprint(entry('Lee K. (2020). Genomes. Genome Res. 30, 1. doi:10.1101/gr.123456.120')), ''); // a CSHL journal
  const asked = [];
  ctx.fetch = async (url) => { asked.push(String(url)); throw new Error('no network'); };
  const r = await T.ckCheckEntry(entry('Lee K. (2023). Large models. arXiv:2301.01234.'), { pause: async () => {} });
  deq([r.verdict, r.preprint, asked.length], ['unverified', true, 0]);
  assert.match(r.text, /^Preprint \(arXiv\): not peer-reviewed/);
});

const CSL = {
  title: 'Interfacial activation of <i>bacterial</i> lipases', 'container-title': 'Journal of Catalysis', volume: '18', issue: '3', page: '45-58',
  issued: { 'date-parts': [[2020, 5]] }, DOI: '10.1000/ABC',
  author: [{ family: 'Smith', given: 'John' }, { family: 'Lee', given: 'Kyung-Min' }, { family: 'van der Waals', given: 'J. D.' }],
};

test('a Crossref record as a plain-text entry: numeric (Vancouver-like) and author-year (APA-like); the style and the number kept', () => {
  assert.strictEqual(T.ckFormatCsl(CSL, 'numeric'), 'Smith J, Lee K-M, van der Waals JD. Interfacial activation of bacterial lipases. Journal of Catalysis. 2020;18(3):45-58. doi:10.1000/abc');
  assert.strictEqual(T.ckFormatCsl(CSL, 'author-year'), 'Smith, J., Lee, K.-M., & van der Waals, J. D. (2020). Interfacial activation of bacterial lipases. Journal of Catalysis, 18(3), 45–58. https://doi.org/10.1000/abc');
  assert.strictEqual(T.ckFormatCsl({ title: 'A book', author: [{ family: 'Doe', given: 'Ann' }] }), 'Doe, A. (n.d.). A book.');
  const seven = { ...CSL, author: Array.from({ length: 7 }, (_, i) => ({ family: 'A' + i, given: 'B' })) };
  assert.ok(T.ckFormatCsl(seven, 'numeric').startsWith('A0 B, A1 B, A2 B, A3 B, A4 B, A5 B, et al. Interfacial'));
  deq(['[3] Smith', '3. Smith', '12) Smith', 'Smith'].map(T.ckEntryPrefix), ['[3] ', '3. ', '12) ', '']);
  const parse = (lines) => lines.map((t) => T.ckParseEntry(t));
  assert.strictEqual(T.ckCitationStyle(parse(['[1] Smith J. A. 2020.', '[2] Lee K. B. 2021.', 'Brown A. (2019). C.'])), 'numeric');
  assert.strictEqual(T.ckCitationStyle(parse(['Smith, J. (2020). A.', 'Lee, K. (2021). B.', '[3] Brown A. C.'])), 'author-year');
  assert.strictEqual(T.ckCitationStyle([]), 'author-year'); // the fallback
});

test('check_references: offered with References on in Auto and Manual; the verdicts as text, at most 50 entries', async () => {
  const tool = T.extraTool('check_references');
  state.settings.references = false;
  const snap0 = snapFor('anthropic');
  assert.ok(!T.offered(tool, 'edit', snap0));
  state.settings.references = true;
  assert.ok(T.offered(tool, 'edit', snap0) && T.offered(tool, 'manual', snap0));
  assert.ok(!T.offered(tool, 'research', snap0));
  assert.ok(T.extraPromptLines('reading', 'manual', snap0).some((l) => l.startsWith('- check_references(): ')));
  assert.strictEqual(T.isExtraReading('check_references', {}), true);
  env.chrome.permissions = { contains: async () => true };
  const lines = ['# Paper', '', 'Text [1] [2] [3].', '', '## References', '',
    '[1] Smith J, Lee K. Lipid rafts in membranes. Cell. 2020;4:1-9. doi:10.1000/good',
    '[2] Doe A. Soil models of carbon. Soil Journal. 2019;3:1-2.',
    '[3] Lee K. Large models. arXiv:2301.01234. 2023.'];
  const snap = { ...snap0, docText: lines.join('\n'), docFormat: 'markdown', model: null, promptView: null, signal: null };
  ctx.fetch = async (url) => {
    const u = String(url);
    if (/v1\/works\/10\.1000\/good/.test(u)) return json({ title: 'Lipid rafts in membranes', author: [{ family: 'Smith' }, { family: 'Lee' }], issued: { 'date-parts': [[2020]] }, 'container-title': 'Cell', DOI: '10.1000/good' });
    if (/openalex\.org\/sources/.test(u)) return json({ results: [] });
    return json({ results: [], message: { items: [] } });
  };
  const timeout = ctx.setTimeout;
  const paced = [];
  ctx.setTimeout = (fn, ms, ...a) => { if (ms === 300) paced.push(ms); return timeout(fn, ms === 300 ? 0 : ms, ...a); }; // the pacing, made instant
  const r = await tool.run('check_references', {}, snap);
  assert.strictEqual(r._ok, true);
  assert.ok(paced.length >= 3); // the same 300 ms pause between requests as /check
  assert.strictEqual(r.content, [
    '1 of 3 reference entries match Crossref or OpenAlex.',
    '[1] Smith (2020), line 7: Match: Matches Crossref by DOI.',
    '[2] Doe (2019), line 8: Suspect: Not found in OpenAlex or Crossref, and OpenAlex does not know the journal «Soil Journal». Check that this work exists.',
    '[3] Lee (2023), line 9: Unverified: Preprint (arXiv): not peer-reviewed, so not checked; look for a published version.',
  ].join('\n'));
  const none = await tool.run('check_references', {}, { ...snap, docText: 'Just text.' });
  assert.match(none.content, /^No reference list found/);
  // more than 50 entries: the first 50, and the rest named
  const many = ['# P', '## References', ...Array.from({ length: 52 }, (_, i) => `[${i + 1}] Smith J. Title number ${i}. Journal. 2019;1:2.`)];
  const big = await tool.run('check_references', {}, { ...snap, docText: many.join('\n') });
  assert.ok(big.content.split('\n')[0].endsWith('; 2 more not checked (at most 50).'), big.content.split('\n')[0]);
  assert.strictEqual(big.content.split('\n').length, 51);
  ctx.setTimeout = timeout;
  state.settings.references = false;
});
