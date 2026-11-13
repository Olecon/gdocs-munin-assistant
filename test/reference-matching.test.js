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
  assert.ok(!T.extraPromptLines('reading', 'manual', snap0).some((l) => l.includes('check_references'))); // its definition says when
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

test('check_references after the turn: the summary line and the entries that are not matches, the worst first, capped and clipped', () => {
  const fn = { name: 'check_references', arguments: '{}' };
  const row = (n, verdict, text) => ({ entry: { n, surname: `Author${n}`, year: '2020', text: '', l: { line: 10 + n } }, verdict, text });
  const results = [row(1, 'ok', 'Matches Crossref by DOI.'), row(2, 'unverified', 'Not found in OpenAlex or Crossref; check it by hand.'),
    row(3, 'warning', 'Matches Crossref by DOI, but year 2020 here, 2021 in Crossref.'), row(4, 'ok', 'Found in OpenAlex.'),
    row(5, 'error', 'The DOI resolves to another work: «A completely different paper about the thermodynamics of soil carbon» (Novak, 2017).'),
    row(6, 'suspect', 'Not found in OpenAlex or Crossref, and OpenAlex does not know the journal «Soil Journal». Check that this work exists.'),
    ...[7, 8, 9, 10].map((n) => row(n, 'unverified', 'Preprint (arXiv): not peer-reviewed, so not checked; look for a published version.')),
    ...Array.from({ length: 20 }, (_, i) => row(11 + i, 'ok', 'Matches Crossref by DOI.'))];
  const text = `${T.ckReferencesText(results, results.length)}\nOpenAlex is not allowed, so only Crossref was searched.`;
  assert.strictEqual(T.readingStub(fn, text, 'after the turn'), [
    '[check_references: 22 of 30 reference entries match Crossref or OpenAlex.',
    '[5] Author5 (2020), line 15: Error: The DOI resolves to another work: «A completely different paper about the…',
    '[6] Author6 (2020), line 16: Suspect: Not found in OpenAlex or Crossref, and OpenAlex does not know the journ…',
    '[3] Author3 (2020), line 13: Warning: Matches Crossref by DOI, but year 2020 here, 2021 in Crossref.',
    '[2] Author2 (2020), line 12: Unverified: Not found in OpenAlex or Crossref; check it by hand.',
    '[7] Author7 (2020), line 17: Unverified: Preprint (arXiv): not peer-reviewed, so not checked; look for a publ…',
    '[8] Author8 (2020), line 18: Unverified: Preprint (arXiv): not peer-reviewed, so not checked; look for a publ…',
    '2 more entries that do not match, and the matching entries omitted after the turn]'].join('\n'));
  const sizes = [T.readingStub(fn, text, 'after the turn').length, text.length];
  assert.ok(sizes[0] < 800 && sizes[1] > 2000, String(sizes)); // under 270 tokens at 3 characters per token
  // every entry matches: the summary line alone
  const all = T.ckReferencesText(Array.from({ length: 12 }, (_, i) => row(i + 1, 'ok', 'Matches Crossref by DOI.')), 12);
  assert.strictEqual(T.readingStub(fn, all, 'after the turn'), '[check_references: 12 of 12 reference entries match Crossref or OpenAlex.\nthe matching entries omitted after the turn]');
  // no reference list (short, kept as it is by the slimming) or another text: no digest
  assert.strictEqual(T.ckReferencesDigest('No reference list found: no entries under a heading such as "References".', 'after the turn'), '');
});

test('check_references and the lookup cache: the same list on the same lines again needs no request; a moved list, a failed lookup or a stopped run asks again', async () => {
  const tool = T.extraTool('check_references');
  state.settings.references = true;
  env.chrome.permissions = { contains: async () => true };
  T.lookupCache.clear();
  const lines = ['# Paper', '', '## References', '', '[1] Smith J, Lee K. Lipid rafts in membranes. Cell. 2020;4:1-9. doi:10.1000/good',
    '[2] Doe A. Soil models of carbon. Soil Journal. 2019;3:1-2.'];
  const snap = { ...snapFor('anthropic'), docId: 'DOC1', docText: lines.join('\n'), docFormat: 'markdown', model: null, promptView: null, signal: null };
  let asked = 0;
  let fail = false;
  ctx.fetch = async (url) => {
    asked++;
    const u = String(url);
    if (fail && /openalex\.org\/works/.test(u)) throw new Error('Failed to fetch');
    if (/v1\/works\/10\.1000\/good/.test(u)) return json({ title: 'Lipid rafts in membranes', author: [{ family: 'Smith' }, { family: 'Lee' }], issued: { 'date-parts': [[2020]] }, 'container-title': 'Cell', DOI: '10.1000/good' });
    return json({ results: [], message: { items: [] } });
  };
  const timeout = ctx.setTimeout;
  ctx.setTimeout = (fn, ms, ...a) => timeout(fn, ms === 300 ? 0 : ms, ...a);
  const r1 = await tool.run('check_references', {}, snap);
  const n = asked;
  const r2 = await tool.run('check_references', {}, { ...snap });
  deq([r2.content, r2._ok, asked], [r1.content, true, n]);
  // the list two lines lower: its line numbers changed, so it is checked again
  const moved = { ...snap, docText: ['', '', ...lines].join('\n') };
  await tool.run('check_references', {}, moved);
  assert.ok(asked > n);
  // a failed lookup is not kept
  T.lookupCache.clear(); fail = true;
  const f = await tool.run('check_references', {}, snap);
  assert.match(f.content, /a lookup failed \(Failed to fetch\)/);
  fail = false; asked = 0;
  await tool.run('check_references', {}, snap);
  assert.ok(asked > 0);
  // a stopped run is not kept
  T.lookupCache.clear();
  const abort = new AbortController();
  ctx.fetch = async () => { abort.abort(); return json({ results: [], message: { items: [] } }); };
  const s = await tool.run('check_references', {}, { ...snap, signal: abort.signal });
  assert.match(s.content, /stopped after/);
  assert.strictEqual(T.lookupCache.size, 0);
  ctx.setTimeout = timeout;
  state.settings.references = false;
});
