'use strict';
// Google Docs numbering of headings (format_lines numbers: set / clear, src/headings.js): one NUMBERED_DECIMAL_NESTED
// list over the headings h1–h3 with their levels, no bullets on the paragraphs between them (body text, a table, a
// heading below the levels), the lists between the headings and leading tabs of body text kept, typed numbers stripped,
// one batch, verified by the re-read, one undo that restores bullets, indents and texts; clear and its undo; the
// structure check reading the list numbers; a title h1 (no number, the sections below it at the first level).
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, installIdentity } = require('./lib/sandbox');
const { docSpec, docsBench } = require('./lib/fake-docs');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, ident, exec, fresh, pushTool, lastPost;

before(async () => {
  env = await load();
  ({ T, state } = env);
  ident = installIdentity(env);
  ({ exec, fresh, pushTool, lastPost } = docsBench(env, ident, ref));
  installDocTab(env);
  env.chrome.tabs.sendMessage = async (id, msg) => (msg.type === 'GET_SELECTION' ? { ok: true, text: '' }
    : msg.type === 'GET_DOC_TEXT' ? { ok: true, text: 'export', format: 'markdown', title: 'My Doc' } : { ok: true, title: 'My Doc' });
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic'; state.googleConnected = true;
});

const texts = () => fake.text('t.0').split('\n');
const styles = () => fake.styles('t.0');
const bullets = () => fake.bullets('t.0');
const pstyles = () => fake.pstyles('t.0');
const posts = () => fake.log.filter((x) => x.method === 'POST').length;
const undo = () => exec('undo_last_edit', {});
const NULLS = { style: null, align: null, list: null, indent_start: null, indent_first_line: null, space_above: null, space_below: null, line_spacing: null, numbers: null };
const fl = (start, end, over) => ({ start, end, ...NULLS, ...over });
const NESTED = 'NUMBERED_DECIMAL_NESTED';

// Lines: 1 title, 2 H1 with a typed number, 3 body, 4 body starting with a tab, 5 H2, 6–7 a bulleted list (levels 0, 1),
// 8 H3, 9–10 a table, 11 body, 12 H4 (below the levels), 13 H1 with a typed number, 14 body.
const mixedSpec = () => docSpec({ items: [
  { p: 'Report', style: 'TITLE' },
  { p: '1. Background', style: 'HEADING_1' },
  { p: 'Body text.' },
  { p: '\tIndented body.' },
  { p: 'Scope', style: 'HEADING_2' },
  { p: 'Item one', bullet: { listId: 'kix.b', preset: 'BULLET_DISC_CIRCLE_SQUARE' } },
  { p: 'Item two', bullet: { listId: 'kix.b', level: 1 } },
  { p: 'Detail', style: 'HEADING_3' },
  { table: [[[{ p: 'A1' }], [{ p: 'B1' }]]] },
  { p: 'After the table.' },
  { p: 'Deep', style: 'HEADING_4' },
  { p: '2.1 Methods', style: 'HEADING_1' },
  { p: 'Last.' },
] });
const HEADS = [2, 5, 8, 13];
const at = (lines, k) => lines[k - 1];

test('numbers set: one nested list over the headings, levels from the heading levels, nothing between them numbered', async () => {
  await fresh(mixedSpec());
  const before = { texts: texts(), styles: styles(), bullets: bullets(), pstyles: pstyles() };
  const n = posts();
  const w = pushTool(await exec('format_lines', fl(1, 14, { numbers: 'set' })));
  assert.ok(w._ok, w.content);
  assert.strictEqual(posts(), n + 1); // one batchUpdate
  // the headings set no font or size of their own: the sheet's go on them, and the result says so
  assert.strictEqual(w.content, 'Done: numbered 4 headings on lines 2, 5, 8, 13 (Google Docs numbering); formatting sheet values added where the heading text had none: Times New Roman, h1 16 pt, h2 14 pt, h3 12 pt; the document has 14 lines.');
  deq([w._edit.kind, w._message, w._cardText], ['heading-list', 'Numbered 4 headings', '1. Background\n1.1. Scope\n1.1.1. Detail\n2. Methods']);
  const reqs = lastPost().requests;
  const made = reqs.filter((r) => r.createParagraphBullets && r.createParagraphBullets.bulletPreset === NESTED);
  assert.strictEqual(made.length, 1); // one list: the numbers run through the document
  // typed numbers stripped, the body tab kept, styles unchanged
  deq(texts(), ['Report', 'Background', 'Body text.', '\tIndented body.', 'Scope', 'Item one', 'Item two', 'Detail', 'A1', 'B1', 'After the table.', 'Deep', 'Methods', 'Last.']);
  deq(styles(), before.styles);
  const b = bullets();
  const id = at(b, 2).listId;
  deq(HEADS.map((k) => at(b, k)), [0, 1, 2, 0].map((level) => ({ listId: id, level, preset: NESTED })));
  for (const k of [1, 3, 4, 9, 10, 11, 12, 14]) assert.strictEqual(at(b, k), null, `line ${k}`);
  // the list between the headings is kept (made again, with its kind and levels)
  deq([6, 7].map((k) => [at(b, k).level, at(b, k).preset, at(b, k).listId !== id]), [[0, 'BULLET_DISC_CIRCLE_SQUARE', true], [1, 'BULLET_DISC_CIRCLE_SQUARE', true]]);
  assert.strictEqual(at(b, 6).listId, at(b, 7).listId);
  // no indent left on the body text by the removed bullets: an explicit 0 where it had none (a reset keeps it in Docs)
  for (const k of [3, 4, 9, 10, 11, 12]) deq(at(pstyles(), k), { ...at(before.pstyles, k), indentStart: 0, indentFirstLine: 0 });
  // the line model: nested list numbers, and the structure check reads them
  const m = as.model;
  assert.strictEqual(m.lines[1].list.nested, true);
  deq([...T.listNumbers(m)], [[2, [1]], [5, [1, 1]], [8, [1, 1, 1]], [13, [2]]]);
  deq(T.structureFindings(m), []);
  // the same call again: nothing to change
  const again = await exec('format_lines', fl(1, 14, { numbers: 'set' }));
  deq([again._ok, again.content], [true, 'No change: the 4 headings in the document are already numbered by Google Docs.']);
  assert.strictEqual(posts(), n + 1);
  // one undo: texts, bullets and indents as before
  const u = await undo();
  assert.ok(u._ok, u.content);
  assert.ok(u.content.startsWith('Done: undid the heading numbering of lines 2–13.'), u.content);
  deq(texts(), before.texts);
  deq(styles(), before.styles);
  deq(bullets().map((x) => x && [x.level, x.preset]), before.bullets.map((x) => x && [x.level, x.preset]));
  // the headings lose their bullet again: no indent of their own before, so an explicit 0 (a reset would keep the list's)
  deq(pstyles(), before.pstyles.map((p, k) => (HEADS.includes(k + 1) ? { ...p, indentStart: 0, indentFirstLine: 0 } : p)));
});

test('numbers set: a document whose top headings are h2 starts at level 0; spaces and tabs before a heading text (or its typed number) go', async () => {
  await fresh(docSpec({ items: [{ p: 'Intro', style: 'HEADING_2' }, { p: 'Text.' }, { p: 'Part', style: 'HEADING_3' }, { p: 'Next', style: 'HEADING_2' }, { p: 'x' }] }));
  const w = pushTool(await exec('format_lines', fl(1, 5, { numbers: 'set' })));
  assert.ok(w._ok, w.content);
  deq(bullets().map((x) => x && x.level), [0, null, 1, 0, null]);
  deq(texts(), ['Intro', 'Text.', 'Part', 'Next', 'x']);
  deq([...T.listNumbers(as.model)], [[1, [1]], [3, [1, 1]], [4, [2]]]);
  // a tab left where a typed number was removed, a space, "3.1<TAB>": Docs draws the number and a tab, so they go (a
  // leading tab would also count as a nesting level)
  await fresh(docSpec({ items: [{ p: '\tIntro', style: 'HEADING_2' }, { p: 'x' }, { p: ' Part', style: 'HEADING_3' }, { p: ' 1.2\tMore', style: 'HEADING_3' }, { p: 'Next', style: 'HEADING_2' }, { p: 'y' }] }));
  const r = pushTool(await exec('format_lines', fl(1, 6, { numbers: 'set' })));
  assert.ok(r._ok, r.content);
  deq([texts(), bullets().map((x) => x && x.level)], [['Intro', 'x', 'Part', 'More', 'Next', 'y'], [0, null, 1, 1, 0, null]]);
  assert.ok((await undo())._ok);
  deq(texts(), ['\tIntro', 'x', ' Part', ' 1.2\tMore', 'Next', 'y']);
});

test('numbers set: the re-read check says per line what Docs drew against the plan, and the next step', async () => {
  await fresh(mixedSpec());
  const plan = T.planNumberHeadings(as.model, { action: 'set' });
  assert.strictEqual(plan.report(as.model), 'Note: Google Docs numbered the headings differently from the plan: line 2 has no number (planned L1); line 5 has no number (planned L2); line 8 has no number (planned L3); line 13 has no number (planned L1). Tell the user to correct them in Google Docs.');
  // levels drawn deeper (the saved chat): the level got against the level planned, the way to fix a level, after the second try
  await fresh(siSpec()); // 1 title, 3 h2, 5 h2, 6 h3, 8 h2
  const p2 = T.planNumberHeadings(as.model, { action: 'set' });
  const lv = { 3: 0, 5: 1, 6: 3, 8: 0 }; // planned 0, 0, 1, 0
  const deep = { ...as.model, lines: as.model.lines.map((l) => (l.line in lv ? { ...l, list: { listId: 'k', level: lv[l.line], kind: 'number', nested: true } } : l)) };
  deq(p2.check(deep).wrong, [{ line: 5, want: 0, got: 1 }, { line: 6, want: 1, got: 3 }]);
  const note = p2.report(deep, true);
  assert.ok(note.startsWith('Note: Google Docs numbered the headings differently from the plan, also after a second try: line 5 is at L2 (planned L1); line 6 is at L4 (planned L2)'), note);
  assert.ok(note.endsWith('Tell the user to correct them in Google Docs (Tab or Shift+Tab at the start of a heading changes its level).'), note);
  // the repair: the lists made again on the document as read, the bullets off first
  const fix = p2.repair(deep);
  assert.ok(fix[0].deleteParagraphBullets && fix.some((r) => r.createParagraphBullets), JSON.stringify(fix).slice(0, 300));
  assert.strictEqual(p2.repair({ ...deep, lines: deep.lines.map((l) => (l.line === 4 ? { ...l, text: 'Changed.' } : l)) }), null); // not as the edit left it
});

test('numbers clear: the bullets and indents of the headings go, the lists between stay; undo makes the numbering again', async () => {
  await fresh(mixedSpec());
  const original = pstyles();
  pushTool(await exec('format_lines', fl(1, 14, { numbers: 'set' })));
  const listed = bullets();
  const w = pushTool(await exec('format_lines', fl(1, 14, { numbers: 'clear' })));
  assert.ok(w._ok, w.content);
  deq([w._edit.kind, w._message], ['heading-list', 'Removed the numbers of 4 headings']);
  // the indents as before; the spacing the sheet gave the headings on set stays (clear removes numbers only)
  const indents = (p) => ({ indentStart: p.indentStart, indentFirstLine: p.indentFirstLine });
  for (const k of HEADS) { assert.strictEqual(at(bullets(), k), null); deq(indents(at(pstyles(), k)), indents(at(original, k))); }
  deq([6, 7].map((k) => at(bullets(), k)), [6, 7].map((k) => at(listed, k)));
  assert.strictEqual(texts()[1], 'Background');
  // nothing numbered any more: the typed clear answers
  const again = await exec('format_lines', fl(1, 14, { numbers: 'clear' }));
  deq([again._ok, again.content], [true, 'No change: the 5 headings in the document are not numbered.']);
  const u = await undo();
  assert.ok(u._ok, u.content);
  const b = bullets();
  const id = at(b, 2).listId;
  deq(HEADS.map((k) => at(b, k) && [at(b, k).listId, at(b, k).level, at(b, k).preset]), [0, 1, 2, 0].map((level) => [id, level, NESTED]));
  for (const k of [3, 4, 9, 10, 11, 12, 14]) assert.strictEqual(at(b, k), null, `line ${k}`);
  deq([6, 7].map((k) => at(b, k).level), [0, 1]);
});

test('numbers set undo: follows text typed above; refused when the text between the headings changed afterwards', async () => {
  await fresh(mixedSpec());
  const before = texts();
  pushTool(await exec('format_lines', fl(1, 14, { numbers: 'set' })));
  fake.typeParagraph(0, 'Typed above');
  const u = await undo();
  assert.ok(u._ok, u.content);
  deq(texts().slice(1), before);
  deq(bullets().slice(1).map((x) => !!x), before.map((t, k) => k === 5 || k === 6));
  pushTool(await exec('format_lines', fl(1, 15, { numbers: 'set' })));
  const r = await exec('replace_text', { old_text: 'Body text.', new_text: 'Body text changed.' });
  assert.ok(r._ok, r.content); // not in the journal: only the numbering is
  const u2 = await undo();
  assert.strictEqual(u2._ok, false);
  assert.ok(u2.content.includes('the headings of that edit changed after it, so it cannot be undone automatically'), u2.content);
});

test('numbers typed after set: the old behaviour (numbers in the text), the bullets untouched', async () => {
  // the only h1, before the other heading, is the title: not numbered, the h2 below it is 1
  await fresh(docSpec({ items: [{ p: 'Intro', style: 'HEADING_1' }, { p: 'Text.' }, { p: 'Part', style: 'HEADING_2' }] }));
  const w = pushTool(await exec('format_lines', fl(1, 3, { numbers: 'typed' })));
  assert.ok(w._ok, w.content);
  deq([w._edit.kind, texts()], ['number-headings', ['Intro', 'Text.', '1 Part']]);
  deq(bullets(), [null, null, null]);
});

// ---- A title h1 (the only h1, before the other headings) -------------------------------------------------------------
// Supporting information: 1 the title (h1), 2 body, 3 h2, 4 body, 5 h2, 6 h3, 7 body, 8 h2.
const siSpec = () => docSpec({ items: [
  { p: 'Supporting Information', style: 'HEADING_1' }, { p: 'Authors.' },
  { p: 'Software', style: 'HEADING_2' }, { p: 'Body.' },
  { p: 'Spectra', style: 'HEADING_2' }, { p: 'Fits', style: 'HEADING_3' }, { p: 'Body.' },
  { p: 'Tables', style: 'HEADING_2' },
] });

test('numbers set under a title h1: the sections are 1, 2, 3 (not 1.1), the title has no number; the same for a range', async () => {
  for (const [a, where] of [[1, 'the document'], [3, 'lines 3–8']]) {
    await fresh(siSpec());
    const before = { texts: texts(), bullets: bullets(), fmt: fake.fmt('t.0')[0] };
    const w = pushTool(await exec('format_lines', fl(a, 8, { numbers: 'set' })));
    assert.ok(w._ok, w.content);
    assert.ok(w.content.startsWith('Done: numbered 4 headings on lines 3, 5, 6, 8 (Google Docs numbering); formatting sheet values'), w.content);
    assert.strictEqual(w._cardText, '1. Software\n2. Spectra\n2.1. Fits\n3. Tables');
    const b = bullets();
    const id = at(b, 3).listId;
    deq(b.map((x) => x && [x.listId === id, x.level]), [null, null, [true, 0], null, [true, 0], [true, 1], null, [true, 0]]);
    deq([...T.listNumbers(as.model)], [[3, [1]], [5, [2]], [6, [2, 1]], [8, [3]]]);
    deq(fake.fmt('t.0')[0], before.fmt); // the title: no sheet values either
    const again = await exec('format_lines', fl(a, 8, { numbers: 'set' }));
    deq([again._ok, again.content], [true, `No change: the 4 headings in ${where} are already numbered by Google Docs.`]);
    assert.ok((await undo())._ok);
    deq([texts(), bullets()], [before.texts, before.bullets]);
  }
});

test('numbers set after an earlier numbering that included the title: the title leaves the list; undo brings it back', async () => {
  const L = 'kix.old';
  const spec = () => docSpec({ items: [
    { p: 'Supporting Information', style: 'HEADING_1', bullet: { listId: L, level: 0, preset: NESTED } }, { p: 'Authors.' },
    { p: 'Software', style: 'HEADING_2', bullet: { listId: L, level: 1 } }, { p: 'Body.' },
    { p: 'Spectra', style: 'HEADING_2', bullet: { listId: L, level: 1 } },
  ] });
  await fresh(spec());
  const before = bullets();
  const plan = T.planNumberHeadings({ ...as.model, sheet: T.styleSheetFor(as) }, { action: 'set' }); // the sheet: the sizes the indents follow
  const w = pushTool(await exec('format_lines', fl(1, 5, { numbers: 'set' })));
  assert.ok(w._ok, w.content);
  assert.ok(w.content.startsWith('Done: numbered 2 headings on lines 3, 5 (Google Docs numbering); removed the number of the title on line 1;'), w.content);
  const b = bullets();
  deq(b.map((x) => x && x.level), [null, null, 0, null, 0]);
  assert.strictEqual(at(b, 3).listId, at(b, 5).listId);
  deq([at(pstyles(), 1).indentStart, at(pstyles(), 1).indentFirstLine], [0, 0]); // no list indent left on the title
  deq([...T.listNumbers(as.model)], [[3, [1]], [5, [2]]]);
  assert.strictEqual(plan.report(as.model), ''); // the re-read check
  const kept = { ...as.model, lines: as.model.lines.map((l, k) => (k ? l : { ...l, list: { listId: L, level: 0, kind: 'number', nested: true } })) };
  assert.strictEqual(plan.report(kept), 'Note: Google Docs numbered the headings differently from the plan: the title on line 1 kept its number. Tell the user to correct it in Google Docs.');
  assert.ok((await undo())._ok);
  const u = bullets();
  deq(u.map((x) => x && x.level), before.map((x) => x && x.level));
  assert.ok(at(u, 1).listId === at(u, 3).listId && at(u, 3).listId === at(u, 5).listId); // one list again
  // clear takes every number, the title's too
  await fresh(spec());
  const c = pushTool(await exec('format_lines', fl(1, 5, { numbers: 'clear' })));
  assert.ok(c.content.startsWith('Done: removed the numbers of 3 headings on lines 1, 3, 5;'), c.content);
  deq(bullets(), [null, null, null, null, null]);
  // a title outside the range is left alone
  await fresh(spec());
  assert.ok(pushTool(await exec('format_lines', fl(3, 5, { numbers: 'set' })))._ok);
  deq(at(bullets(), 1), at(before, 1));
});

test('structureFindings: list numbers of headings count like typed ones', () => {
  const list = (level, nested = true) => ({ listId: 'kix.h', level, kind: 'number', ...(nested ? { nested } : {}) });
  const m = { lines: [
    { line: 1, text: 'Intro', style: 'HEADING_1', heading: 1, list: list(0) },
    { line: 2, text: 'Aims', style: 'HEADING_2', heading: 2, list: list(1) },
    { line: 3, text: '1 Typed', style: 'HEADING_1', heading: 1 },
  ] };
  deq([...T.listNumbers(m)], [[1, [1]], [2, [1, 1]]]);
  deq(T.structureFindings(m).map((x) => x.text), ['heading 1 appears twice (lines 1 and 3)']);
  // another numbered list on headings: its first level only
  const flat = { lines: [{ line: 1, text: 'A', style: 'HEADING_1', heading: 1, list: list(0, false) }, { line: 2, text: 'B', style: 'HEADING_1', heading: 1, list: list(0, false) }] };
  deq([...T.listNumbers(flat)], [[1, [1]], [2, [2]]]);
});

// An article skeleton: H1 sections, H2 subsections, a [[?]] placeholder paragraph after every heading.
const SKELETON = ['# Introduction', '[[?]]', '## Background', '[[?]]', '## Aims', '[[?]]', '## Scope', '[[?]]',
  '# Methods', '[[?]]', '## Samples', '[[?]]', '## Measurements', '[[?]]', '## Analysis', '[[?]]'].join('\n');

test('an outline skeleton numbered by Google Docs: consecutive numbers, no structure findings', async () => {
  await fresh(docSpec({ items: [{ p: 'Paper', style: 'TITLE' }] }));
  const u = { role: 'user', content: 'Write the skeleton and number the headings.' };
  const ins = pushTool(await exec('insert_after_line', { line: 1, text: SKELETON, style: 'outline' }));
  assert.ok(ins._ok, ins.content);
  const set = pushTool(await exec('format_lines', fl(1, 17, { numbers: 'set' })));
  assert.ok(set._ok, set.content);
  const m = await T.fetchDocModel('DOC123', 't.0');
  deq([...T.listNumbers(m)].map(([, n]) => n.join('.')), ['1', '1.1', '1.2', '1.3', '2', '2.1', '2.2', '2.3']);
  deq(T.structureFindings(m), []);
  deq(T.structureFinish(u, as, { docId: 'DOC123', chatId: 'c1', messages: [u, ins, set] }), []);
});

test('the real-Chrome shape: body paragraphs still in the heading list do not shift the heading numbers', async () => {
  // As reported after the skeleton above in real Docs: the placeholder paragraphs carry a bullet of the heading list
  // (at the level of the heading before them). Only headings count, per level, with resets.
  const L = 'kix.h';
  const head = (p, style, level) => ({ p, style, bullet: { listId: L, level, preset: 'NUMBERED_DECIMAL_NESTED' } });
  const body = (level) => ({ p: '[[?]]', bullet: { listId: L, level } });
  await fresh(docSpec({ items: [
    { p: 'Paper', style: 'TITLE' },
    head('Introduction', 'HEADING_1', 0), head('Background', 'HEADING_2', 1), body(1), head('Aims', 'HEADING_2', 1), body(1),
    head('Scope', 'HEADING_2', 1), body(1), head('Methods', 'HEADING_1', 0), body(0), head('Samples', 'HEADING_2', 1), body(1),
    head('Measurements', 'HEADING_2', 1), body(1),
  ] }));
  const m = as.model;
  assert.strictEqual(m.lines[3].list.listId, L); // the shape: a body line in the heading list
  deq([...T.listNumbers(m)].map(([line, n]) => `${line}:${n.join('.')}`), ['2:1', '3:1.1', '5:1.2', '7:1.3', '9:2', '11:2.1', '13:2.2']);
  deq(T.structureFindings(m), []);
});

test('structureFindings: numbers Docs draws in its lists never count as missing or repeated; jumps and stray body text still do', () => {
  const list = (listId, level) => ({ listId, level, kind: 'number', nested: true });
  const line = (n, text, h, l) => ({ line: n, text, style: `HEADING_${h}`, heading: h, list: l });
  // two separate lists (a range numbered on its own restarts at 1): no "appears twice", no "follows"
  const two = { lines: [line(1, 'A', 1, list('a', 0)), line(2, 'B', 2, list('a', 1)), line(3, 'C', 1, list('b', 0)), line(4, 'D', 2, list('b', 1))] };
  deq(T.structureFindings(two), []);
  // a level jump and body text left in a heading style are still named
  const jump = { lines: [line(1, 'Intro', 1, list('a', 0)), line(2, 'Deep', 3, list('a', 2)),
    line(3, 'The effect holds in every sample we measured.', 3, list('a', 2))] };
  deq(T.structureFindings(jump).map((x) => x.text), ['«Deep» (line 2) is H3 right after H1 «Intro»',
    '«The effect holds in every sample we meas…» after «Deep» is still a heading (line 3)']);
});

// A skeleton (H1, H2, H3, a body paragraph after each) on a fake that keeps the indent a deleted bullet leaves when the
// field is only reset, as a real Chrome showed: the body paragraphs get an explicit 0 and sit at the margin. A second H1
// at the end (outside the numbered lines 1–6) makes the first a section, not a title.
const skeleton = () => ({ ...docSpec({ items: [
  { p: 'Intro', style: 'HEADING_1' }, { p: 'Body one.' },
  { p: 'Scope', style: 'HEADING_2' }, { p: 'Body two.' },
  { p: 'Detail', style: 'HEADING_3' }, { p: 'Body three.' },
  { p: 'End', style: 'HEADING_1' },
] }), stickyListIndent: true });

test('numbers set: the number at the body text\'s edge, the text after it; the body paragraphs between the headings get an explicit 0 (a reset keeps the list indent)', async () => {
  await fresh(skeleton());
  const w = pushTool(await exec('format_lines', fl(1, 6, { numbers: 'set' })));
  assert.ok(w._ok, w.content);
  // the sheet's text values on the headings first, then an explicit 0/0 on the span (an indent would count as nesting),
  // the levels as tabs, one list over the span, the bullets off the body paragraphs, then the indents: the headings'
  // numbering indents (Times New Roman, 16/14/12 pt: "1." 12 pt wide, "1.1." 21, "1.1.1." 27, the text half an em after
  // it), the body's 0/0
  const loc = (index) => ({ location: { index, tabId: 't.0' } });
  const rg = (startIndex, endIndex) => ({ range: { startIndex, endIndex, tabId: 't.0' } });
  const zero = { magnitude: 0, unit: 'PT' };
  const P = (magnitude) => ({ magnitude, unit: 'PT' });
  const indent = (s, e, start, first) => ({ updateParagraphStyle: { ...rg(s, e), paragraphStyle: { indentStart: P(start), indentFirstLine: P(first) }, fields: 'indentStart,indentFirstLine' } });
  const font = (size) => ({ textStyle: { weightedFontFamily: { fontFamily: 'Times New Roman', weight: 400 }, fontSize: { magnitude: size, unit: 'PT' } }, fields: 'weightedFontFamily,fontSize' });
  // the sheet's paragraph spacing of the heading's level (the default: space 18/0, 14/0, 12/0)
  const space = (s, e, above) => ({ updateParagraphStyle: { ...rg(s, e), paragraphStyle: { spaceAbove: { magnitude: above, unit: 'PT' }, spaceBelow: zero }, fields: 'spaceAbove,spaceBelow' } });
  deq(lastPost().requests, [
    { updateTextStyle: { ...rg(1, 7), ...font(16) } }, space(1, 7, 18), { updateTextStyle: { ...rg(17, 23), ...font(14) } }, space(17, 23, 14),
    { updateTextStyle: { ...rg(33, 40), ...font(12) } }, space(33, 40, 12),
    indent(1, 40, 0, 0),
    { insertText: { ...loc(33), text: '\t\t' } }, { insertText: { ...loc(17), text: '\t' } },
    { createParagraphBullets: { ...rg(1, 43), bulletPreset: NESTED } },
    { deleteParagraphBullets: rg(7, 17) }, { deleteParagraphBullets: rg(23, 33) },
    indent(1, 7, 20, 12), indent(7, 17, 0, 0), indent(17, 23, 28, 21), indent(23, 33, 0, 0), indent(33, 40, 33, 27),
  ]);
  // the last body paragraph and the h1 after it are below the span: never touched
  deq(pstyles().map((p) => [p.indentStart, p.indentFirstLine]), [[20, 12], [0, 0], [28, 21], [0, 0], [33, 27], [undefined, undefined], [undefined, undefined]]);
  deq(bullets().map((x) => x && x.level), [0, null, 1, null, 2, null, null]);
  // the formatting view: the numbering's own indents are not shown (numberingShown), the body's 0 is the default
  const rd = pushTool(await exec('read_document', { scope: { start: 1, end: 6 }, include: ['formatting'], doc: null }));
  deq(rd.content.split('\n').filter((l) => /^\d+:/.test(l)).map((l) => l.replace(/\].*$/, ']')),
    ['1: [h1 number space 18/0]', '2: Body one.', '3: [h2 number L2 space 14/0]', '4: Body two.', '5: [h3 number L3 space 12/0]', '6: Body three.']);
  // one undo: no bullets, and no list indent left on the headings either (an explicit 0 where there was none)
  assert.ok((await undo())._ok);
  deq(bullets(), [null, null, null, null, null, null, null]);
  deq(pstyles().map((p) => [p.indentStart ?? 0, p.indentFirstLine ?? 0]), [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0]]);
  deq(pstyles().map((p) => [p.spaceAbove, p.spaceBelow]), Array(7).fill([undefined, undefined])); // the sheet's spacing undone
  // a bullet removed at level 0 leaves level × 36 = 0 pt, the inherited value (the real API: real-docs.js fact 1), so the
  // reset after it finds no list indent to keep (stickyListIndent keeps what the removal left: 0); at level 1 it is 36 pt
  await fresh(skeleton());
  const range = (s, e) => ({ segmentId: '', tabId: 't.0', startIndex: s, endIndex: e });
  await T.docsBatchUpdate(as.model, [{ createParagraphBullets: { range: range(1, 7), bulletPreset: NESTED } }, { deleteParagraphBullets: { range: range(1, 7) } },
    { updateParagraphStyle: { range: range(1, 7), paragraphStyle: {}, fields: 'indentStart,indentFirstLine' } }]);
  assert.strictEqual(pstyles()[0].indentStart ?? 0, 0);
  await fresh(skeleton());
  // (the body line after it in the range: a lone line with a tab would be level 0, Docs counts from the shallowest)
  await T.docsBatchUpdate(as.model, [{ insertText: { location: { segmentId: '', tabId: 't.0', index: 1 }, text: '\t' } }, { createParagraphBullets: { range: range(1, 18), bulletPreset: NESTED } },
    { deleteParagraphBullets: { range: range(1, 7) } }, { updateParagraphStyle: { range: range(1, 7), paragraphStyle: {}, fields: 'indentStart,indentFirstLine' } }]);
  assert.strictEqual(pstyles()[0].indentStart, 36);
});

test('the indent a line draws: its own, else its named style\'s, else Normal text\'s, else 0, never its list level\'s (inheritedIndent, sameIndent, numberedHeadingIndent)', () => {
  const list = { listId: 'k', level: 1, kind: 'number', nested: true, indent: { start: 72, first: 54 } };
  const named = { NORMAL_TEXT: { indentFirstLine: 10 }, HEADING_2: { indentStart: 28.5 } };
  deq(T.inheritedIndent(named, 'HEADING_2'), { indentStart: 28.5, indentFirstLine: 10 });
  deq(T.inheritedIndent({}, 'HEADING_2'), { indentStart: 0, indentFirstLine: 0 });
  assert.strictEqual(T.inheritedIndent(null, 'HEADING_2'), null);
  const l = { style: 'HEADING_2', list, para: {} };
  assert.ok(T.sameIndent(l, { indentStart: 28.5, indentFirstLine: 10 }, named));
  assert.ok(!T.sameIndent(l, { indentStart: 72, indentFirstLine: 54 }, named));
  // the named styles unread: an unset indent matches nothing (the caller writes the indent it wants); own values do
  assert.ok(!T.sameIndent(l, { indentStart: 0, indentFirstLine: 0 }));
  assert.ok(T.sameIndent({ ...l, para: { indentStart: 0, indentFirstLine: 0 } }, { indentStart: 0, indentFirstLine: 0 }));
  // numberedHeadingIndent carries the model's named styles, so apply_sheet's two-argument check reads them
  const docs = T.numberedHeadingIndent({ sheet: { numbers: { docs: true } }, named }, l);
  deq([docs.indentStart, docs.indentFirstLine], [72, 54]);
  assert.ok(!T.sameIndent(l, docs)); // no own indent: drawn at 28.5/10, not at the level's 72/54
  assert.ok(T.sameIndent({ ...l, para: { indentStart: 72, indentFirstLine: 54 } }, docs));
  const std = T.numberedHeadingIndent({ sheet: {}, named: {} }, l);
  assert.ok(T.sameIndent(l, std)); // no numbered heading in the model to measure: 0/0, drawn by a heading style without an indent
  // the named styles' indents are read (an explicit 0 is a value)
  deq(T.namedStyleValues({ HEADING_2: { paragraphStyle: { indentStart: { magnitude: 28.5, unit: 'PT' }, indentFirstLine: { unit: 'PT' } } } }).HEADING_2,
    { indentStart: 28.5, indentFirstLine: 0 });
});

test('numbers set: headings in the list at their levels without the numbering indents get them, then "No change"; a named style\'s indent counts for nothing', async () => {
  const H = (p, style, level) => ({ p, style, bullet: { listId: 'kix.h', level, preset: NESTED } });
  const spec = () => docSpec({ items: [H('Background', 'HEADING_1', 0), { p: 'Body one.' }, H('Scope', 'HEADING_2', 1), { p: 'Body two.' }, H('Methods', 'HEADING_1', 0), { p: 'Last.' }] });
  await fresh(spec());
  const w0 = pushTool(await exec('format_lines', fl(1, 6, { numbers: 'set' })));
  assert.ok(w0._ok && w0.content.startsWith('Done: numbered 3 headings on lines 1, 3, 5 (Google Docs numbering)'), w0.content);
  deq(bullets().map((x) => x && x.level), [0, null, 1, null, 0, null]);
  const n = posts();
  const again = await exec('format_lines', fl(1, 6, { numbers: 'set' }));
  deq([again._ok, again.content], [true, 'No change: the 3 headings in the document are already numbered by Google Docs.']);
  assert.strictEqual(posts(), n);
  // the h2 style with an indent (28.5/21.26: 0 levels and 1 by the first line): the numbering writes its own on it, and the
  // h2 keeps level 1
  await fresh(spec());
  const { namedIndents } = require('./lib/tool-eval');
  namedIndents(fake, { HEADING_2: { indentStart: 28.5, indentFirstLine: 40 } });
  const w = pushTool(await exec('format_lines', fl(1, 6, { numbers: 'set' })));
  assert.ok(w._ok && w.content.startsWith('Done: numbered 3 headings on lines 1, 3, 5 (Google Docs numbering)'), w.content);
  deq([1, 3, 5].map((k) => [bullets()[k - 1].level, at(pstyles(), k).indentStart, at(pstyles(), k).indentFirstLine]), [[0, 20, 12], [1, 28, 21], [0, 20, 12]]);
});

// ---- What the real API does to lists (real-docs.js facts num1–num4), in fake-docs and through the panel ------------------
test('fake-docs createParagraphBullets: levels from tabs and first-line indents, counted from the shallowest; list items keep theirs; joins the list before', async () => {
  const range = (s, e) => ({ segmentId: '', tabId: 't.0', startIndex: s, endIndex: e });
  const P = (p, more = {}) => ({ p, ...more });
  // one tab each: level 0 (num1 G2); own 36/36 and a tab: level 2 beside a plain line (G6); 18 and 54/0: level 0 (G8)
  await fresh(docSpec({ items: [P('\ta'), P('\tb'), P('sep'), P('c'), P('\td', { pstyle: { indentStart: 36, indentFirstLine: 36 } }), P('e', { pstyle: { indentStart: 54, indentFirstLine: 0 } })] }));
  await T.docsBatchUpdate(as.model, [{ createParagraphBullets: { range: range(11, 17), bulletPreset: NESTED } }, { createParagraphBullets: { range: range(1, 6), bulletPreset: NESTED } }]);
  deq(bullets().map((x) => x && x.level), [0, 0, null, 0, 2, 0]);
  deq(texts(), ['a', 'b', 'sep', 'c', 'd', 'e']);
  // a removed bullet leaves level × 36 pt: made again with its tab, level 1 becomes 2 (G11, the saved chat's shape)
  const L = (level) => ({ bullet: { listId: 'kix.x', level, preset: NESTED } });
  await fresh(docSpec({ items: [P('a', L(0)), P('b', L(1)), P('c', L(2))] }));
  await T.docsBatchUpdate(as.model, [{ deleteParagraphBullets: { range: range(1, 7) } }, { insertText: { location: { segmentId: '', tabId: 't.0', index: 5 }, text: '\t\t' } },
    { insertText: { location: { segmentId: '', tabId: 't.0', index: 3 }, text: '\t' } }, { createParagraphBullets: { range: range(1, 10), bulletPreset: NESTED } }]);
  deq(bullets().map((x) => x.level), [0, 2, 4]);
  // over list items: they keep their bullet and tabs (G10); a plain line after an item joins its list at its level (num4 J3)
  await fresh(docSpec({ items: [P('a', L(0)), P('b', L(1)), P('c')] }));
  await T.docsBatchUpdate(as.model, [{ createParagraphBullets: { range: range(5, 6), bulletPreset: NESTED } }]);
  deq(bullets().map((x) => x && [x.listId, x.level]), [['kix.x', 0], ['kix.x', 1], ['kix.x', 1]]);
});

test('numbers set on headings numbered before (one list or several, any level), twice, a range and then all: the planned levels, one list', async () => {
  const H = (p, n, bullet) => ({ p, style: `HEADING_${n}`, ...(bullet ? { bullet } : {}) });
  const L = (listId, level) => ({ listId, level, preset: NESTED });
  // the saved chat's shapes: one list at deeper levels than planned, a second list, a body line in the heading list
  const spec = () => docSpec({ items: [H('Paper title', 1), { p: 'Authors.' }, H('Introduction', 2, L('a', 0)), { p: 'Intro body.' }, H('Scope', 3, L('a', 2)),
    { p: 'Scope body.' }, H('Methods', 2, L('a', 0)), H('Data', 3, L('a', 1)), H('Detail', 4, L('a', 3)), { p: 'Detail body.', bullet: L('a', 1) },
    H('Results', 2, L('b', 0)), H('Sub result', 3, L('b', 0)), { p: 'Result body.' }, H('Outlook', 3, L('b', 1)), { p: 'End.' }] });
  const want = [null, null, 0, null, 1, null, 0, 1, 2, null, 0, 1, null, 1, null];
  await fresh(spec());
  const w = pushTool(await exec('format_lines', fl(3, 15, { numbers: 'set' })));
  assert.ok(w._ok, w.content);
  deq(bullets().map((x) => x && x.level), want);
  assert.strictEqual(new Set(bullets().filter(Boolean).map((x) => x.listId)).size, 1);
  deq([...T.listNumbers(as.model)].map(([k, x]) => `${k}:${x.join('.')}`), ['3:1', '5:1.1', '7:2', '8:2.1', '9:2.1.1', '11:3', '12:3.1', '14:3.2']);
  assert.ok(!w.content.includes('Note:'), w.content);
  deq(texts()[9], 'Detail body.'); // the body line left the heading list
  // twice: no change
  const again = await exec('format_lines', fl(3, 15, { numbers: 'set' }));
  assert.ok(again.content.startsWith('No change'), again.content);
  // a range, then a range that leaves the first one out: one list, and the result says so
  await fresh(docSpec({ items: [H('Paper title', 1), H('Abstract', 2), { p: 'x' }, H('Methods', 2), H('Data', 3), { p: 'y' }, H('Results', 2), { p: 'z' }, H('Sub', 3)] }));
  pushTool(await exec('format_lines', fl(4, 5, { numbers: 'set' })));
  const r = pushTool(await exec('format_lines', fl(7, 9, { numbers: 'set' })));
  assert.ok(r.content.startsWith('Done: numbered 4 headings on lines 4, 5, 7, 9 (Google Docs numbering, one list with the 2 numbered before outside lines 7–9)'), r.content);
  deq([...T.listNumbers(as.model)].map(([k, x]) => `${k}:${x.join('.')}`), ['4:1', '5:1.1', '7:2', '9:2.1']); // Abstract stays unnumbered
  // two adjacent subsections alone (no level-0 line between them): a plain line before lends itself, so they keep L2, L3
  await fresh(docSpec({ items: [H('Paper title', 1), H('Methods', 2), { p: 'x' }, H('Data', 3), H('Detail', 4), { p: 'y' }] }));
  const a = pushTool(await exec('format_lines', fl(4, 5, { numbers: 'set' })));
  assert.ok(a._ok, a.content);
  deq(bullets().map((x) => x && x.level), [null, null, null, 1, 2, null]);
  deq(pstyles()[2], {}); // the anchor line: its bullet gone again, no indent of its own
  // numbers clear on a section: the result names the headings whose numbers change
  await fresh(spec());
  pushTool(await exec('format_lines', fl(3, 15, { numbers: 'set' })));
  const c = pushTool(await exec('format_lines', fl(7, 9, { numbers: 'clear' })));
  assert.ok(c.content.startsWith('Done: removed the numbers of 3 headings on lines 7, 8, 9; the numbers of the other headings change (lines 11, 12, 14);'), c.content);
});

test('a numbering Docs draws otherwise is made again once; what stays wrong is named per line with the next step; one note for several numbering operations', async () => {
  // two subsections at the start, no plain line next to them to lend itself (the next starts with a tab): Docs counts
  // their levels from the shallower one, so they come out at L1 and L2 instead of L2 and L3, also on the second try
  await fresh(docSpec({ items: [{ p: 'Data', style: 'HEADING_3' }, { p: 'Detail', style: 'HEADING_4' }, { p: '\tIndented.' }, { p: 'Methods', style: 'HEADING_2' }, { p: 'x' }, { p: 'Results', style: 'HEADING_2' }] }));
  const n = posts();
  const w = pushTool(await exec('format_lines', fl(1, 2, { numbers: 'set' })));
  assert.strictEqual(posts(), n + 2); // the edit and the second try
  assert.ok(w.content.endsWith('\nNote: Google Docs numbered the headings differently from the plan, also after a second try: line 1 is at L1 (planned L2); line 2 is at L2 (planned L3). Tell the user to correct them in Google Docs (Tab or Shift+Tab at the start of a heading changes its level).'), w.content);
  assert.ok(!w.content.includes('read_document'), w.content);
  // edit_document with several numbering operations: one note, the lines of all of them
  await fresh(mixedSpec());
  const plan = T.planEditDocument(as.model, { operations: [{ op: 'number_headings', start: 2, end: 5, numbers: 'set' }, { op: 'number_headings', start: 13, end: 13, numbers: 'set' }] });
  assert.ok(!plan.error, plan.error);
  const note = plan.report(as.model);
  assert.strictEqual(note.match(/Note:/g).length, 1, note);
  assert.ok(note.includes('line 2 has no number (planned L1); line 5 has no number (planned L2); line 13 has no number (planned L1)'), note);
});

test('format_lines with style and numbers (and apply_sheet): the style first, then the numbers, one batch, one undo', async () => {
  const L = (level) => ({ bullet: { listId: 'kix.k', level, preset: NESTED } });
  const spec = () => docSpec({ items: [{ p: 'Methods', style: 'HEADING_2', ...L(0) }, { p: 'x' }, { p: '2.1 Model objects' }, { p: 'y' },
    { p: 'Results', style: 'HEADING_2', ...L(0) }, { p: 'z' }] });
  for (const extra of [{}, { apply_sheet: true }]) {
    await fresh(spec());
    const before = { t: texts(), s: styles(), b: bullets().map((x) => x && x.level), p: pstyles() };
    const n = posts();
    const w = pushTool(await exec('format_lines', fl(3, 3, { style: 'h3', numbers: 'set', ...extra })));
    assert.ok(w._ok, w.content);
    assert.strictEqual(posts(), n + 1);
    assert.ok(w.content.startsWith('Done: formatted line 3 (h3); '), w.content);
    assert.ok(w.content.includes('numbered 3 headings on lines 1, 3, 5 (Google Docs numbering, one list with the 2 numbered before outside line 3)'), w.content);
    deq(w.content.split('\n').filter((l) => l.startsWith('Note:')), ['Note: the named style makes h3 text #434343.']); // the colour note alone
    deq(styles()[2], 'HEADING_3');
    deq(texts()[2], 'Model objects'); // the typed number went
    deq(bullets().map((x) => x && x.level), [0, null, 1, null, 0, null]);
    assert.strictEqual(new Set(bullets().filter(Boolean).map((x) => x.listId)).size, 1);
    deq(w._edit.kind, 'multi');
    const u = await undo();
    assert.ok(u._ok, u.content);
    deq([texts(), styles(), bullets().map((x) => x && x.level)], [before.t, before.s, before.b]);
  }
});

test('edit_document: number_headings set with replaces that only remove typed numbers: the error says they are not needed', async () => {
  await fresh(docSpec({ items: [{ p: '1. Intro', style: 'HEADING_2' }, { p: 'x' }, { p: '1.1 Scope', style: 'HEADING_3' }, { p: 'Plain line' }, { p: '2. End', style: 'HEADING_2' }] }));
  const ops = [{ op: 'replace', old_text: '1. Intro', new_text: 'Intro', line: 1 }, { op: 'replace', old_text: '1.1 Scope', new_text: 'Scope', line: 3 },
    { op: 'number_headings', start: 1, end: 5, numbers: 'set' }];
  let r = await exec('edit_document', { operations: ops });
  deq([r._ok, r.content], [false, 'Error: operation 3 (number_headings lines 1–5) removes typed heading numbers itself, so operations 1, 2 are not needed: send this call without them']);
  // three of them, and a format_lines on those lines: the replaces are not needed, the format_lines goes first, the numbering second
  const end = { op: 'replace', old_text: '2. End', new_text: 'End', line: 5 };
  r = await exec('edit_document', { operations: [...ops.slice(0, 2), end, { op: 'format_lines', start: 4, end: 4, style: 'h3' }, ops[2]] });
  assert.strictEqual(r.content, 'Error: operation 5 (number_headings lines 1–5) removes typed heading numbers itself, so operations 1–3 are not needed. operation 5 (number_headings lines 1–5) overlaps operation 4 (format_lines line 4). Send this call without operations 1–3, 5, then operation 5 in a second edit_document call');
  // a replace that changes more than the number still overlaps
  r = await exec('edit_document', { operations: [{ op: 'replace', old_text: '1. Intro', new_text: 'Introduction', line: 1 }, ops[2]] });
  assert.ok(r.content.startsWith('Error: operation 2 (number_headings lines 1–5) overlaps operation 1 (replace «1. Intro»). Send this call without operation 2'), r.content);
  // the numbering alone then does what the replaces did
  const w = pushTool(await exec('edit_document', { operations: [ops[2]] }));
  assert.ok(w._ok, w.content);
  deq(texts(), ['Intro', 'x', 'Scope', 'Plain line', 'End']);
});

test('numbering indents: from the body text\'s own start indent; the view hides them, shows any other; a longer number widens its level', async () => {
  const B = { pstyle: { indentStart: 36, indentFirstLine: 0 } };
  const items = (n) => [{ p: 'Paper', style: 'HEADING_1' }, { p: 'Body one.', ...B }, { p: 'Intro', style: 'HEADING_2' }, { p: 'Body two.', ...B },
    ...Array.from({ length: n }, (_, k) => ({ p: `Part ${k + 1}`, style: 'HEADING_3' })), { p: 'Body three.', ...B }, { p: 'End', style: 'HEADING_2' }];
  await fresh(docSpec({ items: items(2) }));
  assert.ok(pushTool(await exec('format_lines', fl(1, 8, { numbers: 'set' })))._ok);
  // Times New Roman 14 pt "1." is 10.5 pt wide, 12 pt "1.1." 18: the numbers end there after the body's 36 pt
  deq([3, 5, 6, 8].map((k) => [at(pstyles(), k).indentStart, at(pstyles(), k).indentFirstLine]), [[53.5, 46.5], [60, 54], [60, 54], [53.5, 46.5]]);
  const view = async () => pushTool(await exec('read_document', { scope: { start: 1, end: 8 }, include: ['formatting'], doc: null })).content.split('\n').filter((l) => /^\d+:/.test(l)).map((l) => l.replace(/\].*$/, ']'));
  deq((await view()).filter((l) => /\[h[23]/.test(l)), ['3: [h2 number space 14/0]', '5: [h3 number L2 space 12/0]', '6: [h3 number L2 space 12/0]', '8: [h2 number space 14/0]']);
  // a heading moved by hand shows its indent; numbers set puts it back
  assert.ok(pushTool(await exec('format_lines', fl(5, 5, { indent_start: 0, indent_first_line: 0 })))._ok);
  assert.ok((await view()).includes('5: [h3 number L2 indent 0/0 space 12/0]'));
  assert.ok(pushTool(await exec('format_lines', fl(1, 8, { numbers: 'set' })))._ok);
  deq([at(pstyles(), 5).indentStart, at(pstyles(), 5).indentFirstLine], [60, 54]);
  // ten subsections: "1.10." is the longest of its level, 24 pt
  await fresh(docSpec({ items: items(10) }));
  assert.ok(pushTool(await exec('format_lines', fl(1, 16, { numbers: 'set' })))._ok);
  deq([at(pstyles(), 5).indentStart, at(pstyles(), 5).indentFirstLine], [66, 60]);
});

test('formatting view: an explicit 0 indent on a list line that differs from the level\'s is shown; on a plain line it is not; a list heading without an own indent reads "indent style"', () => {
  const list = { listId: 'k', level: 0, kind: 'number', nested: true, indent: { start: 36, first: 18 } };
  assert.strictEqual(T.lineTag({ style: 'HEADING_1', list, para: { indentStart: 0, indentFirstLine: 0 } }), 'h1 number indent 0/0');
  // no own indent: Docs draws the named style's, not the level's (chrome-check line-starts), so it is not hidden as the level's
  assert.strictEqual(T.lineTag({ style: 'HEADING_1', list, para: {} }), 'h1 number indent style');
  assert.strictEqual(T.lineTag({ style: 'HEADING_1', list, para: { indentStart: 36, indentFirstLine: 18 } }), 'h1 number');
  assert.strictEqual(T.lineTag({ style: 'NORMAL_TEXT', list, para: {} }), 'number');
  assert.strictEqual(T.lineTag({ style: 'NORMAL_TEXT', list: null, para: { indentStart: 0, indentFirstLine: 0 } }), '');
});
