'use strict';
// The references tools (src/references.js): offered with the References grant (cite only in Auto with the Docs
// API), prompt lines and the turn context note; find_reference (Zotero listing, no match, Zotero absent or its API
// off, DOIs through Crossref); cite insert into an existing References section, after a bare heading, and into a new
// section at the end; author-date order; numeric styles with renumbering (and a citation edited by hand); refresh;
// style changes; exact undo with the store restored; errors.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, installIdentity, waitFor } = require('./lib/sandbox');
const { docSpec, docsBench } = require('./lib/fake-docs');
const { fakeZotero } = require('./lib/fake-zotero');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, storage, bench, z;

before(async () => {
  env = await load();
  T = env.T;
  state = env.state;
  storage = env.storage;
  const ident = installIdentity(env);
  bench = docsBench(env, ident, ref);
  installDocTab(env);
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic'; state.googleConnected = true;
  // Chrome grants the reference hosts (a failed lookup checks again: references-access.test.js)
  env.chrome.permissions = { contains: async () => true, request: async () => true };
});

// A fresh document, Zotero and Crossref; the grant; no stored citations.
async function fresh(items, { references = true } = {}) {
  await bench.fresh(docSpec({ items }));
  z = fakeZotero();
  env.ctx.fetch = bench.routeDocs((url, init) => z.fetch(url, init));
  T.resetZoteroStatus();
  state.settings.references = references;
  delete storage['muninCitations:DOC123'];
  T.citeCache.clear();
}
const exec = (name, args) => bench.exec(name, args);
const push = (r) => bench.pushTool(r);
const NULLS = { ids: null, after_text: null, style: null };
const insert = (ids, after) => exec('cite', { ...NULLS, action: 'insert', ids, after_text: after });
const text = () => fake.text('t.0').split('\n');
const store = () => storage['muninCitations:DOC123'];
const newTurn = () => { as = T.takeSnapshot(); T.snapshotDocument(as); };
// An edit that removes a tracked citation waits at the edit gate (write-guards.test.js): allowed here.
async function allowed(promise) {
  await waitFor(() => T.pendingPreviews.size === 1, 'the gate card');
  const [[id]] = [...T.pendingPreviews.entries()];
  T.decidePreview(id, 'accept');
  return promise;
}

const BODY = [
  { p: 'Rafts', style: 'TITLE' },
  { p: 'Lipid rafts are ordered domains.' },
  { p: 'Cholesterol matters too.' },
];

test('offered with the grant; cite only in Auto with the Docs API; prompt lines and the context note follow', async () => {
  await fresh(BODY, { references: false });
  newTurn();
  const names = (mode, snap = as) => T.toolsFor(mode, snap).map((t) => t.function.name);
  assert.ok(!names('edit').includes('find_reference') && !names('edit').includes('cite'));
  assert.ok(!T.buildSystemParts('edit', 1e5, as).head.includes('find_reference'));
  state.settings.references = true;
  deq(names('edit').slice(-5), ['find_reference', 'cite', 'draft', 'revise_section', 'check_references']); // revise_section: src/revise.js; check_references: src/check-refs.js
  assert.ok(names('manual').includes('find_reference') && !names('manual').includes('cite'));
  assert.ok(!names('edit', { ...as, docFormat: 'markdown', model: null }).includes('cite'));
  const head = T.buildSystemParts('edit', 1e5, as).head;
  assert.ok(head.includes("- find_reference(query): look up works to cite in the user's Zotero library or by DOI; returns ids for cite."));
  assert.ok(head.includes('- cite(action, ids, after_text, style): "insert" puts an in-text citation'));
  assert.ok(!T.buildSystemParts('manual', 1e5, as).head.includes('- cite('));
  // the schemas: strict, every property required
  const cite = T.toolsFor('edit', as).find((t) => t.function.name === 'cite').function.parameters;
  deq([cite.required, cite.additionalProperties, cite.properties.action.enum], [['action', 'ids', 'after_text', 'style'], false, ['insert', 'refresh', 'style']]);
  // turned off mid-chat: a call is refused like an unknown tool
  state.settings.references = false;
  const r = await exec('find_reference', { query: 'smith' });
  deq([r._ok, r.content], [false, 'Error: find_reference is not available for this message.']);
  state.settings.references = true;
  // the context note appears once the document has cited items
  assert.ok(!T.buildTurnContext('edit', as, null).includes('References:'));
  push(await insert(['zotero:ABCD1234'], 'ordered domains'));
  await T.runTurnHooks('panelDoc', 'DOC123');
  newTurn();
  assert.ok(T.buildTurnContext('edit', as, null).includes('</document>\nReferences: 1 cited item, style apa'));
  assert.strictEqual(T.EXTRA_TOOLS.find((t) => t.names.includes('cite')).icon, '📚');
  assert.strictEqual(T.pendingCardText('cite'), 'Citing…');
  // the gate: a rewrite that removes GATE_REPLACE_CHARS or more asks; smaller ones only in tainted turns
  deq(T.editGateInfo('cite', { removedChars: 2000, removedText: 'old list', gateWhat: 'rewrites the References section' }),
    { large: true, what: 'rewrites the References section', range: '', excerptLabel: 'Removed text', excerpt: 'old list' });
  assert.strictEqual(T.editGateInfo('cite', { removedChars: 10, removedText: '' }).large, false);
});

test('find_reference: Zotero listing, no match, Zotero absent or its API off, DOIs through Crossref', async () => {
  await fresh(BODY);
  let r = await exec('find_reference', { query: 'smith 2020' });
  deq([r._ok, r._reading, r._message], [true, true, '"smith 2020"']);
  assert.strictEqual(r.content, '1 Zotero item for "smith 2020":\nzotero:ABCD1234: Smith, J.; Lee, K. (2020). Lipid rafts in membranes. Biophysical Journal. doi:10.1016/j.bpj.2020.01.001');
  assert.ok(z.calls.every((c) => c.headers['Zotero-Allowed-Request'] === '1'));
  r = await exec('find_reference', { query: 'nothing here' });
  assert.strictEqual(r.content, 'No Zotero items match "nothing here". Try an author\'s last name, a title word or a year, or give a DOI.');
  // a DOI in the library is found there; one not in it goes to Crossref
  r = await exec('find_reference', { query: 'https://doi.org/10.1016/j.bpj.2020.01.001' });
  assert.ok(r.content.startsWith('1 Zotero item for'), r.content);
  r = await exec('find_reference', { query: 'doi:10.1038/nphys1234' });
  assert.strictEqual(r.content, 'Not in Zotero; DOI 10.1038/nphys1234 (Crossref):\ndoi:10.1038/nphys1234: Doe, J.; Roe, R.; Poe, P. (2019). Membrane physics. Nature Physics.');
  r = await exec('find_reference', { query: '10.9999/missing' });
  deq([r._ok, r.content], [false, 'Error: Crossref does not know DOI "10.9999/missing". Check the DOI; DOIs registered elsewhere (DataCite, mEDRA) are not supported.']);
  // Zotero not running
  z.running = false; T.resetZoteroStatus();
  r = await exec('find_reference', { query: 'smith' });
  assert.strictEqual(r.content, 'Error: Zotero is not running (nothing answers on localhost:23119). Ask the user to start Zotero 7 with Zotero → Settings → Advanced → "Allow other applications on this computer to communicate with Zotero" turned on, or give a DOI.');
  r = await exec('find_reference', { query: '10.1038/nphys1234' });
  assert.ok(r._ok && r.content.startsWith('Zotero is not running; DOI 10.1038/nphys1234 (Crossref):'), r.content);
  // the local API setting off
  z.running = true; z.apiOn = false; T.resetZoteroStatus();
  r = await exec('find_reference', { query: 'smith' });
  assert.strictEqual(r.content, 'Error: Zotero is running but its local API is off. Ask the user to turn on Zotero → Settings → Advanced → "Allow other applications on this computer to communicate with Zotero", or give a DOI.');
  r = await exec('find_reference', { query: '  ' });
  assert.strictEqual(r.content, 'Error: query is empty. Give an author, title words, a year or a DOI.');
});

test('cite insert: a new References section at the end (top heading level), the store, exact undo', async () => {
  await fresh([...BODY, { p: 'Methods', style: 'HEADING_2' }, { p: 'We measured.' }]);
  const r = push(await insert(['zotero:ABCD1234'], 'ordered domains'));
  assert.ok(r._ok, r.content);
  deq(text(), ['Rafts', 'Lipid rafts are ordered domains (Smith & Lee, 2020).', 'Cholesterol matters too.', 'Methods', 'We measured.', 'References',
    'Smith, J., & Lee, K. (2020). Lipid rafts in membranes. Biophysical Journal.']);
  deq(fake.styles('t.0').slice(-3), ['NORMAL_TEXT', 'HEADING_2', 'NORMAL_TEXT']);
  assert.strictEqual(r.content, 'Done: inserted « (Smith & Lee, 2020)» after «ordered domains» on line 2; References (lines 6–7) lists 1 work.\n' +
    'Lines 2, 6, 7 now:\n2: Lipid rafts are ordered domains (Smith & Lee, 2020).\n6: References\n7: Smith, J., & Lee, K. (2020). Lipid rafts in membranes. Biophysical Journal.\nThe document now has 7 lines.');
  deq([r._message, r._cardText, r._cardLabel, r._edit.kind], ['Cited Smith & Lee 2020 on line 2', ' (Smith & Lee, 2020)', 'Citation', 'cite']);
  // one batch: the bibliography first (back to front), then the citation
  const posts = fake.log.filter((x) => x.method === 'POST');
  assert.strictEqual(posts.length, 1);
  deq(posts[0].body.requests.map((q) => Object.keys(q)[0]), ['insertText', 'updateParagraphStyle', 'updateParagraphStyle', 'insertText']);
  const s = store();
  deq([s.style, s.numeric, s.order, s.rev], ['apa', false, ['zotero:ABCD1234'], 1]);
  deq(s.marks, [{ ids: ['zotero:ABCD1234'], label: '(Smith & Lee, 2020)', before: 'are ordered domains ' }]);
  deq(s.items['zotero:ABCD1234'], { src: 'zotero', key: 'ABCD1234', label: '(Smith & Lee, 2020)', bib: 'Smith, J., & Lee, K. (2020). Lipid rafts in membranes. Biophysical Journal.', short: 'Smith & Lee 2020' });
  // the action log
  assert.strictEqual(T.toolCallSummary('cite', { action: 'insert', ids: ['zotero:ABCD1234'], after_text: 'ordered domains' }), 'insert zotero:ABCD1234 after "ordered domains"');
  // undo: the text, the styles and the store as before
  const u = await exec('undo_last_edit', {});
  assert.ok(u._ok, u.content);
  deq(text(), ['Rafts', 'Lipid rafts are ordered domains.', 'Cholesterol matters too.', 'Methods', 'We measured.']);
  deq(fake.styles('t.0').slice(-2), ['HEADING_2', 'NORMAL_TEXT']);
  assert.ok(u.content.startsWith('Done: undid "Cited Smith & Lee 2020 on line 2".\nLines 2, 5 now:\n2: Lipid rafts are ordered domains.\n5: We measured.'), u.content);
  deq([store().order, store().marks, store().rev], [[], [], 0]);
});

test('cite insert: inside an existing References section (before the next heading), alphabetical, minimal rewrite', async () => {
  await fresh([...BODY, { p: 'References:', style: 'HEADING_1' }, { p: 'Zeta, Z. (1999). Old entry.' }, { p: '' }, { p: 'Appendix', style: 'HEADING_1' }, { p: 'Data.' }]);
  let r = push(await insert(['zotero:ABCD1234'], 'ordered domains'));
  assert.ok(r._ok, r.content);
  deq(text(), ['Rafts', 'Lipid rafts are ordered domains (Smith & Lee, 2020).', 'Cholesterol matters too.', 'References:',
    'Smith, J., & Lee, K. (2020). Lipid rafts in membranes. Biophysical Journal.', '', 'Appendix', 'Data.']);
  assert.ok(r.content.includes('; References: (lines 4–5) lists 1 work.'), r.content);
  // a second work: sorted before Smith; only the new entry is written
  newTurn();
  r = push(await insert(['zotero:EFGH5678'], 'matters too'));
  assert.ok(r._ok, r.content);
  deq(text().slice(3, 7), ['References:', 'Brown, A. M. (2018). Cholesterol and order. Springer.', 'Smith, J., & Lee, K. (2020). Lipid rafts in membranes. Biophysical Journal.', '']);
  assert.strictEqual(text()[2], 'Cholesterol matters too (Brown, 2018).');
  const last = fake.log.filter((x) => x.method === 'POST').pop().body.requests;
  deq(last.filter((q) => q.insertText).map((q) => q.insertText.text), ['Brown, A. M. (2018). Cholesterol and order. Springer.\n', ' (Brown, 2018)']);
  // two works at once, one already cited: "(A; B)"
  newTurn();
  r = push(await insert(['zotero:EFGH5678', 'ZOTERO:abcd1234'], 'Rafts'));
  assert.ok(r._ok, r.content);
  assert.strictEqual(text()[0], 'Rafts (Brown, 2018; Smith & Lee, 2020)');
  assert.ok(r.content.includes('lists 2 works'), r.content);
  // undo the last one only
  const u = await exec('undo_last_edit', {});
  assert.ok(u._ok, u.content);
  assert.strictEqual(text()[0], 'Rafts');
  deq(store().marks.length, 2);
});

test('cite insert: after a bare References heading; DOIs through Crossref (author-date label)', async () => {
  await fresh([...BODY, { p: 'Bibliography', style: 'HEADING_1' }]);
  const r = push(await insert(['doi:10.1038/nphys1234'], 'Cholesterol matters too'));
  assert.ok(r._ok, r.content);
  deq(text(), ['Rafts', 'Lipid rafts are ordered domains.', 'Cholesterol matters too (Doe et al., 2019).', 'Bibliography',
    'Doe, J., Roe, R., & Poe, P. (2019). Membrane physics. Nature Physics. https://doi.org/10.1038/nphys1234']);
  deq(fake.styles('t.0').slice(-2), ['HEADING_1', 'NORMAL_TEXT']);
  const u = await exec('undo_last_edit', {});
  assert.ok(u._ok, u.content);
  deq(text(), ['Rafts', 'Lipid rafts are ordered domains.', 'Cholesterol matters too.', 'Bibliography']);
  deq(fake.styles('t.0').slice(-1), ['HEADING_1']);
});

test('numeric style: [n] labels in order of first citation, renumbering, a citation edited by hand, refresh', async () => {
  await fresh([...BODY, { p: 'Results are clear.' }]);
  let r = push(await exec('cite', { ...NULLS, action: 'style', style: 'IEEE' }));
  deq([r._ok, r.content], [true, 'Done: the citation style of this document is now ieee (numeric); no works are cited yet.']);
  newTurn();
  r = push(await insert(['zotero:ABCD1234'], 'Results are clear'));
  assert.ok(r._ok, r.content);
  newTurn();
  // an earlier position: becomes [1], the other one [2]
  r = push(await insert(['zotero:EFGH5678'], 'ordered domains'));
  assert.ok(r._ok, r.content);
  deq(text(), ['Rafts', 'Lipid rafts are ordered domains [1].', 'Cholesterol matters too.', 'Results are clear [2].', 'References',
    '[1] A. M. Brown, Cholesterol and order. Springer, 2018.', '[2] J. Smith and K. Lee, “Lipid rafts in membranes,” Biophys. J., 2020.']);
  assert.ok(r.content.includes('; renumbered 1 citation'), r.content);
  deq(store().order, ['zotero:EFGH5678', 'zotero:ABCD1234']);
  // a citation of both
  newTurn();
  r = push(await insert(['zotero:ABCD1234', 'zotero:EFGH5678'], 'matters too'));
  assert.strictEqual(text()[2], 'Cholesterol matters too [1, 2].');
  // undo restores the numbers of the previous edit
  push(await exec('undo_last_edit', {}));
  assert.strictEqual(text()[2], 'Cholesterol matters too.');
  deq(store().marks.map((m) => m.label), ['[2]', '[1]']);
  newTurn();
  r = await exec('cite', { ...NULLS, action: 'refresh' });
  deq([r._ok, r.content], [true, 'Done: nothing to change; References (lines 5–7) lists 2 works and the citations are up to date.']);
  // Crossref DOI in a numeric style: the entry's own "[1]" is replaced by the panel's number
  newTurn();
  r = push(await insert(['10.1038/nphys1234'], 'Cholesterol matters too'));
  assert.ok(r._ok, r.content);
  deq(text().slice(1, 4), ['Lipid rafts are ordered domains [1].', 'Cholesterol matters too [2].', 'Results are clear [3].']);
  deq(text().slice(-3), ['[1] A. M. Brown, Cholesterol and order. Springer, 2018.', '[2] J. Doe, R. Roe, and P. Poe, “Membrane physics,” Nature Physics, 2019.', '[3] J. Smith and K. Lee, “Lipid rafts in membranes,” Biophys. J., 2020.']);
  assert.ok(r.content.includes('renumbered 1 citation'), r.content);
  // the user deletes a citation by hand: it cannot be found and keeps its label; refresh renumbers the rest
  newTurn();
  push(await allowed(exec('replace_text', { old_text: 'domains [1].', new_text: 'domains.' })));
  newTurn();
  r = push(await exec('cite', { ...NULLS, action: 'refresh' }));
  assert.ok(r._ok, r.content);
  deq(text().slice(1, 4), ['Lipid rafts are ordered domains.', 'Cholesterol matters too [1].', 'Results are clear [2].']);
  deq(text().slice(-3), ['[1] J. Doe, R. Roe, and P. Poe, “Membrane physics,” Nature Physics, 2019.', '[2] J. Smith and K. Lee, “Lipid rafts in membranes,” Biophys. J., 2020.', '[3] A. M. Brown, Cholesterol and order. Springer, 2018.']);
  assert.ok(r.content.startsWith('Done: refreshed the bibliography; References (lines 5–8) lists 3 works; relabeled 2 citations.'), r.content);
  assert.ok(r.content.endsWith('\nNote: 1 earlier citation («[1]») could not be found in the text (edited by hand?) and keeps its label.'), r.content);
  assert.strictEqual(r._message, 'References refreshed (3)');
});

test('undo: found again after text above moved it; refused when the citation changed; the store is kept when it changed since', async () => {
  await fresh([...BODY]);
  const r = push(await insert(['zotero:ABCD1234'], 'ordered domains'));
  fake.typeParagraph(0, 'Typed above meanwhile');
  let u = await exec('undo_last_edit', {});
  assert.ok(u._ok, u.content);
  deq(text(), ['Typed above meanwhile', 'Rafts', 'Lipid rafts are ordered domains.', 'Cholesterol matters too.']);
  // again, then the citation is edited: refused
  await fresh([...BODY]);
  const r2 = push(await insert(['zotero:ABCD1234'], 'ordered domains'));
  newTurn();
  push(await allowed(exec('replace_text', { old_text: '(Smith & Lee, 2020)', new_text: '(Smith and Lee, 2020)' })));
  await assert.rejects(T.undoEdit(r2._edit), /the citation or the References section changed after that edit, so it cannot be undone automatically/);
  // the store changed after the edit (another tab cited): the document is undone, the store kept, with a note
  await fresh([...BODY]);
  push(await insert(['zotero:ABCD1234'], 'ordered domains'));
  storage['muninCitations:DOC123'] = { ...store(), rev: 7 };
  u = await exec('undo_last_edit', {});
  assert.ok(u._ok && u.content.includes('\nNote: the list of cited works changed after that edit and was kept; call cite with action "refresh" if the References section looks wrong.'), u.content);
  deq(store().rev, 7);
  assert.ok(r._ok);
});

test('style change relabels located citations and rewrites the bibliography; undo restores both', async () => {
  await fresh([...BODY, { p: 'Results are clear.' }]);
  push(await insert(['zotero:ABCD1234'], 'Results are clear'));
  newTurn();
  push(await insert(['zotero:EFGH5678'], 'ordered domains'));
  newTurn();
  const before = text();
  const r = push(await exec('cite', { ...NULLS, action: 'style', style: 'ieee' }));
  assert.ok(r._ok, r.content);
  deq(text().slice(1, 4), ['Lipid rafts are ordered domains [1].', 'Cholesterol matters too.', 'Results are clear [2].']);
  assert.strictEqual(r._message, 'Citation style set to ieee');
  assert.ok(r.content.startsWith('Done: set the citation style to ieee (numeric); References (lines 5–7) lists 2 works; relabeled 2 citations.'), r.content);
  deq([store().style, store().numeric], ['ieee', true]);
  const u = await exec('undo_last_edit', {});
  assert.ok(u._ok, u.content);
  deq(text(), before);
  deq([store().style, store().numeric], ['apa', false]);
});

test('errors: ids, after_text not found or repeated or in the bibliography, Zotero absent, Docs API changed meanwhile', async () => {
  await fresh([...BODY, { p: 'Rafts again.' }]);
  let r = await insert([], 'ordered');
  assert.strictEqual(r.content, 'Error: insert needs ids: the ids that find_reference returned (zotero:KEY or doi:10.…).');
  r = await insert(['smith2020'], 'ordered');
  assert.strictEqual(r.content, 'Error: "smith2020" is not an id from find_reference (zotero:KEY or doi:10.…); call find_reference first.');
  r = await insert(['zotero:ABCD1234'], null);
  assert.ok(r.content.startsWith('Error: insert needs after_text'), r.content);
  r = await insert(['zotero:ABCD1234'], 'Rafts');
  assert.strictEqual(r.content, 'Error: after_text occurs 2 times (lines 1, 4); give more of the text so that it occurs once.');
  r = await insert(['zotero:ABCD1234'], 'disordered domains');
  assert.ok(/^Error: after_text not found\. Closest match/.test(r.content), r.content);
  r = await exec('cite', { ...NULLS, action: 'refresh' });
  assert.strictEqual(r.content, 'Error: no works are cited in this document yet; use action "insert" first.');
  r = await exec('cite', { ...NULLS, action: 'style', style: 'not a style!' });
  assert.ok(r.content.startsWith('Error: style must be a CSL style id'), r.content);
  r = await exec('cite', { ...NULLS, action: 'remove' });
  assert.strictEqual(r.content, 'Error: action must be "insert", "refresh" or "style".');
  z.running = false; T.resetZoteroStatus();
  r = await insert(['zotero:ABCD1234'], 'ordered domains');
  assert.ok(r.content.startsWith('Error: Zotero is not running (nothing answers on localhost:23119).'), r.content);
  z.running = true; T.resetZoteroStatus();
  r = await insert(['zotero:ZZZZ9999'], 'ordered domains');
  assert.strictEqual(r.content, 'Error: Zotero has no item ZZZZ9999; find it again with find_reference.');
  push(await insert(['zotero:ABCD1234'], 'ordered domains'));
  newTurn();
  r = await insert(['zotero:EFGH5678'], 'Lipid rafts in membranes');
  assert.strictEqual(r.content, 'Error: after_text is in the References section; cite in the text instead.');
  // nothing was written by the refusals
  assert.strictEqual(fake.log.filter((x) => x.method === 'POST').length, 1);
  // the document changed after it was read: the batch is refused and nothing is stored
  fake.typeParagraph(0, 'Typed meanwhile');
  r = await insert(['zotero:EFGH5678'], 'matters too');
  assert.ok(!r._ok && /document changed after it was read/.test(r.content), r.content);
  deq(store().order, ['zotero:ABCD1234']);
});
