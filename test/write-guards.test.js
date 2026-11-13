'use strict';
// Guards on the write path: replace_section (heading resolution, the body range, always gated, undo, refusals),
// the citation guard of the edit gate (an edit that removes a tracked in-text citation always asks), and the
// citation integrity check after an editing turn (a row of the turn, the next turn's References note).
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, waitFor, load, installDocTab, installIdentity } = require('./lib/sandbox');
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
  env.chrome.permissions = { contains: async () => true, request: async () => true };
});

async function fresh(items, { references = false } = {}) {
  await bench.fresh(docSpec({ items }));
  z = fakeZotero();
  env.ctx.fetch = bench.routeDocs((url, init) => z.fetch(url, init));
  T.resetZoteroStatus();
  state.settings.references = references;
  delete storage['muninCitations:DOC123'];
  T.citeCache.clear();
}
const exec = (name, args, id) => bench.exec(name, args, id);
const push = (r) => bench.pushTool(r);
const text = () => fake.text('t.0').split('\n');
const posts = () => fake.log.filter((x) => x.method === 'POST').length;
const newTurn = () => { as = T.takeSnapshot(); T.snapshotDocument(as); };
// The turn was sent in Manual: every write asks (Auto asks about no section replacement or citation removal).
const manual = () => { as.askEdits = true; };
const section = (heading, newText) => exec('replace_section', { heading, new_text: newText });
const block = (label, text) => `<div class="code-wrap edit-block pv-text"><div class="code-bar"><span class="code-lang">${label}</span></div><pre>${text}</pre></div>`;

// A call that must show the gate card: decides it and returns { r, html }.
async function decided(promise, decision) {
  await waitFor(() => T.pendingPreviews.size === 1, 'the gate card');
  const [[id, p]] = [...T.pendingPreviews.entries()];
  const html = p.card.innerHTML;
  assert.ok(T.decidePreview(id, decision));
  return { r: await promise, html };
}
async function noCard(promise) {
  const r = await promise;
  assert.strictEqual(T.pendingPreviews.size, 0);
  assert.strictEqual(r._decision, undefined);
  return r;
}

const DOC = [
  { p: 'Report', style: 'TITLE' }, // 1
  { p: 'Intro text.' }, // 2
  { p: 'Methods', style: 'HEADING_1' }, // 3
  { p: 'We measured.' }, // 4
  { p: 'Setup', style: 'HEADING_2' }, // 5
  { p: 'Details here.' }, // 6
  { p: 'Results', style: 'HEADING_1' }, // 7
  { p: 'All good.' }, // 8
  { p: 'Empty part', style: 'HEADING_1' }, // 9
  { p: 'Last', style: 'HEADING_1' }, // 10
  { p: 'Final words.' }, // 11
  { p: 'End line.' }, // 12
];
const ORIGINAL = DOC.map((x) => x.p);

test('replace_section: the tool, its description and action-log row', async () => {
  await fresh(DOC);
  newTurn();
  const names = T.toolsFor('edit', as).map((t) => t.function.name);
  assert.ok(T.WRITE_TOOLS.includes('replace_section') && names.includes('replace_section'));
  assert.ok(!T.toolsFor('manual', as).map((t) => t.function.name).includes('replace_section'));
  const def = T.TOOL_DEFS.replace_section.function.parameters;
  deq([def.required, def.additionalProperties], [['heading', 'new_text'], false]);
  assert.ok(!T.buildSystemParts('edit', 1e5, as).head.includes('- replace_section(')); // no prompt line: the definition describes it
  // when to prefer replace_text: revise.js's routing line; whether it asks is the mode's (Auto: never, Manual: always)
  assert.ok(T.TOOL_DEFS.replace_section.function.description.endsWith('empty empties the section.'));
  assert.strictEqual(T.toolCallSummary('replace_section', { heading: 'Methods', new_text: 'x' }), '«Methods»');
});

test('replace_section: a body with a subsection, the card in Manual (the section\'s new text whole, the diff), the report, exact undo; Auto asks nothing', async () => {
  await fresh(DOC);
  manual();
  // case-insensitive, spaces collapsed; the H2 inside belongs to the H1 section
  const d = await decided(section('  methods ', 'New body.\nSecond para.'), 'accept');
  const r = push(d.r);
  assert.ok(r._ok, r.content);
  assert.strictEqual(r._decision, 'accepted');
  assert.ok(d.html.includes('<span class="pv-tool">replace_section</span> · Allow this edit?'), d.html);
  assert.ok(d.html.includes('<div class="pv-note">Replaces the section «Methods» (lines 3–6).</div>' + block('The section «Methods» after the edit', 'New body.\nSecond para.')) && !d.html.includes('Large edit'), d.html);
  assert.ok(d.html.includes('<summary>What changed</summary><div class="word-diff"><del>We measured</del><ins>New body</ins>.\n<del>Setup\nDetails here</del><ins>Second para</ins>.</div>'), d.html);
  deq(text(), ['Report', 'Intro text.', 'Methods', 'New body.', 'Second para.', 'Results', 'All good.', 'Empty part', 'Last', 'Final words.', 'End line.']);
  deq(fake.styles('t.0').slice(0, 6), ['TITLE', 'NORMAL_TEXT', 'HEADING_1', 'NORMAL_TEXT', 'NORMAL_TEXT', 'HEADING_1']);
  assert.strictEqual(r.content, 'Done: replaced the section «Methods» (lines 3–6); now lines 3–5; the document has 11 lines.');
  deq([r._message, r._edit.kind, r._cardLabel, r._cardText], ['Replaced the section «Methods» (lines 3–6)', 'replace', 'New text', 'New body.\nSecond para.']);
  // line numbers moved: a line-number write later in the same response is refused
  const stale = await bench.exec('delete_lines', { start: 2, end: 2 }, 'stale', true);
  assert.ok(!stale._ok && /line numbers changed after the previous edit/.test(stale.content), stale.content);
  const u = push(await exec('undo_last_edit', {}));
  assert.ok(u._ok, u.content);
  deq(text(), ORIGINAL);
  deq(fake.styles('t.0'), DOC.map((x) => x.style || 'NORMAL_TEXT'));
  // Auto: the same replacement runs without a card
  newTurn();
  const auto = push(await noCard(section('Methods', 'New body.')));
  assert.ok(auto._ok, auto.content);
});

test('replace_section: the last section runs to the end; an empty section gets a body; empty new_text empties', async () => {
  await fresh(DOC);
  manual();
  let d = await decided(section('LAST', 'Only this.'), 'accept');
  assert.ok(d.r._ok, d.r.content);
  assert.ok(d.html.includes('Replaces the section «Last» (lines 10–12).'), d.html);
  deq(text().slice(9), ['Last', 'Only this.']);
  // a section without body lines (the next heading follows at once): the text goes in after it as normal text
  d = await decided(section('Empty part', 'Filled.\nTwice.'), 'accept');
  const r = push(d.r);
  assert.ok(r._ok, r.content);
  assert.ok(d.html.includes('Replaces the section «Empty part» (line 9).') && d.html.includes(block('The section «Empty part» after the edit', 'Filled.\nTwice.')) && !d.html.includes('What changed'), d.html);
  deq(text().slice(8, 12), ['Empty part', 'Filled.', 'Twice.', 'Last']);
  deq(fake.styles('t.0').slice(8, 12), ['HEADING_1', 'NORMAL_TEXT', 'NORMAL_TEXT', 'HEADING_1']);
  assert.ok(r.content.startsWith('Done: replaced the section «Empty part» (line 9); now lines 9–11;'), r.content);
  assert.ok(push(await exec('undo_last_edit', {}))._ok);
  deq(text().slice(8, 10), ['Empty part', 'Last']);
  // empty new_text: the body lines go, the heading stays (and keeps its style); the card shows what goes
  d = await decided(section('Results', ''), 'accept');
  assert.ok(d.html.includes(block('Removed: the text of «Results»', 'All good.')), d.html);
  const e = push(d.r);
  assert.ok(e._ok, e.content);
  deq(text().slice(6, 9), ['Results', 'Empty part', 'Last']);
  deq(fake.styles('t.0').slice(6, 9), ['HEADING_1', 'HEADING_1', 'HEADING_1']);
  deq([e._message, e._edit.kind], ['Emptied the section «Results» (lines 7–8)', 'delete']);
  assert.ok(push(await exec('undo_last_edit', {}))._ok);
  deq(text().slice(6, 9), ['Results', 'All good.', 'Empty part']);
  // the last section emptied: the newline before it goes (the document's last paragraph cannot)
  d = await decided(section('Last', ''), 'accept');
  assert.ok(d.r._ok, d.r.content);
  deq(text().slice(-2), ['Empty part', 'Last']);
  deq(fake.styles('t.0').slice(-1), ['HEADING_1']);
  // nothing to change: an ok "No change" (not an error for the repeat guard), no card, nothing sent
  let n = await noCard(section('Empty part', ''));
  deq([n._ok, n.content, n._message], [true, 'No change: the section «Empty part» is already empty.', 'No change']);
  n = await noCard(section('Results', 'All good.'));
  deq([n._ok, n.content, n._edit], [true, 'No change: the section «Results» already reads that.', undefined]);
});

test('replace_section: heading not found (closest headings), several matches, no headings; Deny writes nothing', async () => {
  await fresh([...DOC, { p: 'Results', style: 'HEADING_2' }, { p: 'More.' }]);
  let r = await noCard(section('Method', 'x'));
  assert.strictEqual(r.content, 'Error: no heading reads "Method". Closest headings: "Methods" (line 3), "Report" (line 1), "Setup" (line 5), "Results" (line 7), "Empty part" (line 9). Pass the heading text exactly as the outline shows it (case does not matter)');
  r = await noCard(section('results', 'x'));
  assert.strictEqual(r.content, 'Error: 2 headings read "results": "Results" (line 7), "Results" (line 13). Pass more of the heading or edit with replace_text');
  assert.strictEqual(r._message, 'replace_section: 2 headings match');
  r = await noCard(section(' ', 'x'));
  assert.ok(/heading is empty/.test(r.content));
  manual();
  const before = posts();
  const d = await decided(section('Setup', 'Changed.'), 'reject');
  deq([d.r._ok, d.r._decision, posts()], [false, 'rejected', before]);
  deq(text().slice(0, 12), ORIGINAL);
  await fresh([{ p: 'Plain' }, { p: 'Text' }]);
  r = await noCard(section('Plain', 'x'));
  assert.strictEqual(r.content, 'Error: the document has no headings, so there is no section to replace. Use replace_text');
});

test('replace_section: refused on suggestions, tables and embedded objects', async () => {
  await fresh([{ p: 'A', style: 'HEADING_1' }, { p: 'Suggested words', suggest: true }, { p: 'B', style: 'HEADING_1' }, { p: 'b' }]);
  let r = await noCard(section('A', 'New.'));
  assert.ok(!r._ok && /suggested changes/.test(r.content), r.content);
  r = await noCard(section('A', ''));
  assert.ok(!r._ok && /suggested changes/.test(r.content), r.content);
  await fresh([{ p: 'A', style: 'HEADING_1' }, { p: 'x' }, { table: [[[{ p: 'Cell' }]]] }, { p: 'y' }]);
  r = await noCard(section('A', 'New.'));
  assert.strictEqual(r.content, 'Error: the section «A» contains a table, which replace_section cannot rewrite. Edit the text around it with replace_text');
  const OC = String.fromCharCode(0xFFFC);
  await fresh([{ p: 'A', style: 'HEADING_1' }, { p: 'Image ' + OC + ' here' }, { p: 'B', style: 'HEADING_1' }]);
  r = await noCard(section('A', 'New.'));
  assert.ok(!r._ok && /embedded object/.test(r.content), r.content);
  r = await noCard(section('A', ''));
  assert.ok(!r._ok && /embedded object/.test(r.content), r.content);
  assert.strictEqual(posts(), 0);
});

// ---- Citations --------------------------------------------------------------------------------------------------
const BODY = [
  { p: 'Rafts', style: 'TITLE' },
  { p: 'Lipid rafts are ordered domains.' },
  { p: 'Cholesterol matters too.' },
  { p: 'Results are clear.' },
];
const NULLS = { ids: null, after_text: null, style: null };
// The document with two numeric citations: line 2 "… domains [1].", line 4 "… clear [2].", References after.
async function cited() {
  await fresh(BODY, { references: true });
  push(await exec('cite', { ...NULLS, action: 'style', style: 'ieee' }));
  newTurn();
  push(await exec('cite', { ...NULLS, action: 'insert', ids: ['zotero:ABCD1234'], after_text: 'Results are clear' }));
  newTurn();
  push(await exec('cite', { ...NULLS, action: 'insert', ids: ['zotero:EFGH5678'], after_text: 'ordered domains' }));
  newTurn();
  deq(text().slice(1, 4), ['Lipid rafts are ordered domains [1].', 'Cholesterol matters too.', 'Results are clear [2].']);
}

test('citation guard: replace_selection through the API names the citation on the Manual card', async () => {
  await cited();
  state.selection = 'Results are clear [2].';
  newTurn(); manual();
  const before = posts();
  let d = await decided(exec('replace_selection', { text: 'Results are unclear.' }), 'reject');
  assert.ok(d.html.includes('Replaces line 4. It removes citation [2].'), d.html);
  deq([d.r._ok, posts()], [false, before]);
  newTurn(); manual(); // the denied call is not asked again in the same turn
  d = await decided(exec('replace_selection', { text: 'Results are unclear.' }), 'accept');
  assert.ok(push(d.r)._ok, d.r.content);
  assert.strictEqual(text()[3], 'Results are unclear.');
  assert.strictEqual(d.r._detail, 'Removed citation [2].');
  state.selection = '';
});

test('citation guard: Auto removes a tracked citation without a card (the writing check refuses once, as for any citation); the row names it', async () => {
  await cited();
  const drop = { old_text: 'domains [1].', new_text: 'domains.' };
  const once = await noCard(exec('replace_text', drop));
  assert.ok(!once._ok && once.content.startsWith('Refused by a check: the new text drops [1].'), once.content);
  const r = push(await noCard(exec('replace_text', drop)));
  assert.ok(r._ok, r.content);
  assert.strictEqual(r._detail, 'Removed citation [1].');
  // the row's fold shows it, in the existing detail line
  const tc = { id: 'cite_row', function: { name: 'replace_text', arguments: JSON.stringify(drop) } };
  assert.ok(T.writeRow(T.logEntry(tc, r)).innerHTML.includes('<div class="log-detail">Removed citation [1].</div>'));
  assert.ok(push(await exec('undo_last_edit', {}))._ok);
  assert.strictEqual(text()[1], 'Lipid rafts are ordered domains [1].');
});

test('citation guard: in Manual removing a tracked citation asks and says so; Deny refuses; Allow applies and undo restores', async () => {
  await cited();
  manual();
  let before = posts();
  let d = await decided(exec('replace_text', { old_text: 'domains [1].', new_text: 'domains.' }), 'reject');
  assert.ok(d.html.includes('Replaces line 2. It removes citation [1].') && !d.html.includes('Large edit'), d.html);
  deq([d.r._ok, d.r._decision, d.r.content, posts()], [false, 'rejected', 'The user did not allow this edit. Do not retry it; ask what they want instead or propose an alternative in the chat.', before]);
  newTurn(); manual(); // the denied call is not asked again in the same turn
  d = await decided(exec('replace_text', { old_text: 'domains [1].', new_text: 'domains.' }), 'accept');
  const r = push(d.r);
  assert.ok(r._ok, r.content);
  assert.strictEqual(text()[1], 'Lipid rafts are ordered domains.');
  assert.ok(push(await exec('undo_last_edit', {}))._ok);
  assert.strictEqual(text()[1], 'Lipid rafts are ordered domains [1].');
  // replace_all over both citations (the "]" of the References entries do not count)
  newTurn(); manual();
  before = posts();
  d = await decided(exec('replace_all', { old_text: ']', new_text: ')' }), 'reject');
  assert.ok(d.html.includes('It removes citations [1], [2].'), d.html);
  assert.strictEqual(posts(), before);
  // delete_lines of a cited line; a tainted turn adds its sentence
  as.tainted = true;
  d = await decided(exec('delete_lines', { start: 4, end: 4 }), 'reject');
  assert.ok(d.html.includes('Deletes line 4. It removes citation [2]. Earlier in this answer'), d.html);
  as.tainted = false;
  newTurn();
  // edits that leave the citations alone pass as before
  let n = push(await noCard(exec('replace_text', { old_text: 'matters too', new_text: 'counts too' })));
  assert.ok(n._ok, n.content);
  n = push(await noCard(exec('replace_text', { old_text: 'ordered domains [1]', new_text: 'ordered regions [1]' })));
  assert.ok(n._ok, n.content);
  assert.strictEqual(text()[1], 'Lipid rafts are ordered regions [1].');
  // without the References grant the guard still names it: it reads only the document's store (no lookups)
  state.settings.references = false;
  manual();
  d = await decided(exec('replace_text', { old_text: 'regions [1].', new_text: 'regions.' }), 'reject');
  assert.ok(d.html.includes('It removes citation [1].'), d.html);
  // the helper itself
  state.settings.references = true;
  newTurn();
  const at = as.model.text.indexOf('[2]');
  deq(await T.citationsInRanges(as.model, [[at + 1, at + 2]]), ['[2]']);
  deq(await T.citationsInRanges(as.model, [[at - 3, at]]), []);
  deq(await T.citationsInRanges(as.model, [[at, at]]), []);
});

test('citation guard: a section with a citation; an empty store or literal brackets never ask', async () => {
  await fresh([...BODY.slice(0, 1), { p: 'Intro', style: 'HEADING_1' }, ...BODY.slice(1)], { references: true });
  push(await exec('cite', { ...NULLS, action: 'style', style: 'ieee' }));
  newTurn();
  push(await exec('cite', { ...NULLS, action: 'insert', ids: ['zotero:ABCD1234'], after_text: 'ordered domains' }));
  newTurn(); manual();
  const d = await decided(section('Intro', 'Rewritten.'), 'reject');
  assert.ok(d.html.includes('Replaces the section «Intro» (lines 2–5). It removes citation [1].'), d.html);
  as.askEdits = false;
  // no stored citations: "[1]" typed by hand is plain text
  await fresh([{ p: 'T', style: 'TITLE' }, { p: 'See [1] here.' }], { references: true });
  // (the prose check refuses the first call that drops "[1]"; the identical retry passes: src/prose-lint.js)
  const args = { old_text: 'See [1] here.', new_text: 'See here.' };
  const first = await noCard(exec('replace_text', args));
  assert.ok(!first._ok && first.content.startsWith('Refused by a check: the new text drops [1].'), first.content);
  const r = await noCard(exec('replace_text', args));
  assert.ok(r._ok, r.content);
});

test('Manual, after "Allow all in this turn": replace_section and an edit that removes a citation still ask; other writes do not', async () => {
  await cited();
  newTurn(); manual();
  as.editAll = true; // as after "Allow all in this turn" on an earlier card of this turn
  let d = await decided(exec('replace_text', { old_text: 'domains [1].', new_text: 'domains.' }), 'reject');
  assert.ok(d.html.includes('It removes citation [1].'), d.html);
  assert.strictEqual(d.r._decision, 'rejected');
  // other writes (a tainted turn too) stay covered by Allow all
  as.tainted = true;
  const small = push(await exec('replace_text', { old_text: 'Cholesterol matters too.', new_text: 'Cholesterol counts.' }));
  assert.strictEqual(T.pendingPreviews.size, 0);
  deq([small._ok, small._decision], [true, 'accepted-all']);
  await fresh(DOC);
  newTurn(); manual();
  as.editAll = true;
  d = await decided(section('Methods', 'New body.'), 'accept');
  assert.ok(d.html.includes('Replaces the section «Methods» (lines 3–6).'), d.html);
  assert.ok(push(d.r)._ok, d.r.content);
  assert.strictEqual(d.r._decision, 'accepted');
});

// ---- Integrity check after a turn -------------------------------------------------------------------------------
// The rows of the turn the check produced (render.js addLateTurnRow: stored on the turn's last message once idle).
const lateRows = [];
const rowTexts = () => lateRows.slice();
const clearRows = () => {
  lateRows.length = 0;
  env.ctx.addLateTurnRow = (t, at) => { lateRows.push(t); assert.ok(at && at.role, 'on the turn\'s last message'); };
};
const userMsg = () => ({ role: 'user', content: 'edit' });

test('integrity check: a lost citation gives a row of the turn and the next note; a clean or no-edit turn says nothing', async () => {
  await cited();
  clearRows();
  // an edit that leaves the citations alone: no row
  let u = userMsg();
  let res = await noCard(exec('replace_text', { old_text: 'matters too', new_text: 'counts too' }));
  await T.checkCitationsAfterTurn(u, as, { messages: [u, { role: 'tool', ...res }] });
  deq(rowTexts(), []);
  // a turn that removed [1] (allowed at the card of a Manual turn)
  newTurn(); manual();
  const d = await decided(exec('replace_text', { old_text: 'domains [1].', new_text: 'domains.' }), 'accept');
  u = userMsg();
  await T.checkCitationsAfterTurn(u, as, { messages: [u, { role: 'tool', ...d.r }] });
  const msg = 'Citation [1] is no longer in the text. cite with action "refresh" rebuilds the References list.';
  deq(rowTexts(), [msg]);
  // the next turn's context tells the model
  newTurn();
  assert.ok(T.buildTurnContext('edit', as, null).includes(`References: 2 cited items, style ieee. After the last edit: ${msg}`), T.buildTurnContext('edit', as, null));
  // a turn without an edit: no check (no new row) and the note is dropped afterwards
  u = userMsg();
  await T.checkCitationsAfterTurn(u, as, { messages: [u, { role: 'tool', content: 'Lines 1-2 of 6', _ok: true, _reading: true }] });
  assert.strictEqual(rowTexts().length, 1);
  newTurn();
  assert.ok(!T.buildTurnContext('edit', as, null).includes('After the last edit'));
  // a deleted References section and a hand-edited list are reported too; earlier turns' edits do not count
  clearRows();
  const old = { role: 'tool', ...d.r };
  const sec = text().indexOf('References') + 1;
  res = push(await exec('delete_lines', { start: sec, end: text().length }));
  assert.ok(res._ok, res.content);
  u = userMsg();
  await T.checkCitationsAfterTurn(u, as, { messages: [old, u] });
  deq(rowTexts(), []);
  await T.checkCitationsAfterTurn(u, as, { messages: [old, u, { role: 'tool', ...res }] });
  deq(rowTexts(), ['Citation [1] is no longer in the text. The References section is missing. cite with action "refresh" rebuilds the References list.']);
  // without the References grant the check still runs (no lookups)
  clearRows();
  state.settings.references = false;
  await T.checkCitationsAfterTurn(u, as, { messages: [u, { role: 'tool', ...res }] });
  assert.strictEqual(rowTexts().length, 1);
});

test('integrity check: an agent\'s edit (on its delegate result, _agent.edits) is checked like the main model\'s', async () => {
  await cited();
  clearRows();
  newTurn(); manual();
  const d = await decided(exec('replace_text', { old_text: 'domains [1].', new_text: 'domains.' }), 'accept');
  const u = userMsg();
  const delegateResult = { role: 'tool', tool_call_id: 'c_agent', content: 'Agent status: ok', _ok: true,
    _agent: { status: 'ok', edits: [{ role: 'tool', tool_call_id: d.r._edit.id, content: '', _ok: true, _edit: d.r._edit }] } };
  await T.checkCitationsAfterTurn(u, as, { messages: [u, delegateResult] });
  deq(rowTexts(), ['Citation [1] is no longer in the text. cite with action "refresh" rebuilds the References list.']);
});

test('integrity check: numbering out of order and a list that no longer matches', async () => {
  await cited();
  clearRows();
  // moving the second citation's sentence above the first: the numbers no longer follow the text
  let res = push(await exec('replace_text', { old_text: 'Rafts', new_text: 'Rafts\nResults are clear [2].' }));
  assert.ok(res._ok, res.content);
  newTurn(); manual();
  // the original sentence goes (its citation is still tracked there: the Manual card names it)
  res = push((await decided(exec('delete_lines', { start: 5, end: 5 }), 'accept')).r);
  assert.ok(res._ok, res.content);
  // "[2]" now occurs once again (line 2), before "[1]"
  const u = userMsg();
  await T.checkCitationsAfterTurn(u, as, { messages: [u, { role: 'tool', ...res }] });
  deq(rowTexts(), ['The citation numbers are out of order. cite with action "refresh" rebuilds the References list.']);
  // an entry edited by hand
  clearRows();
  newTurn();
  res = push(await exec('replace_text', { old_text: 'Cholesterol and order', new_text: 'Cholesterol and disorder' }));
  assert.ok(res._ok, res.content);
  await T.checkCitationsAfterTurn(u, as, { messages: [u, { role: 'tool', ...res }] });
  assert.ok(rowTexts()[0].includes('The References list does not match the citations.'), rowTexts()[0]);
});
