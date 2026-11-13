'use strict';
// The document's named styles (src/named-styles.js): document_styles read (the styles as they are, the sheet's values where
// they differ) and apply (the updateNamedStyle requests and their mask for the default sheet on a default Arial document,
// "No change", the gate, undo of the exact former values, the fallback when Google refuses the request and the per-session
// flag; which errors mark it unavailable), the note after the first write of a visible turn (the styles never change by
// themselves; once per turn, not for a document with its own formatting), right-to-left alignment, the formatting view's
// "Unmarked text" after an update, the schema.
const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, installIdentity, waitFor } = require('./lib/sandbox');
const { docSpec, docsBench } = require('./lib/fake-docs');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, exec, fresh, pushTool;

before(async () => {
  env = await load();
  ({ T, state } = env);
  const ident = installIdentity(env);
  ({ exec, fresh, pushTool } = docsBench(env, ident, ref));
  installDocTab(env);
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic'; state.googleConnected = true;
});
// Every test starts a new panel session for the named styles.
beforeEach(() => { T.namedStylesSession.unavailable = ''; });

const TNR = 'Times New Roman';
const posts = () => fake.log.filter((x) => x.method === 'POST');
const apply = (id) => exec('document_styles', { action: 'apply' }, id);
const read = () => exec('document_styles', { action: 'read' });
const undo = async () => { const u = pushTool(await exec('undo_last_edit', {})); assert.ok(u._ok, u.content); return u; };
// A short document: too little text for the first-run measure, so it has no formatting of its own.
const short = (over = {}) => docSpec({ items: [{ p: 'Intro', style: 'HEADING_1' }, { p: 'First body paragraph.' }, { p: 'Second.' }], ...over });
// The named styles of a document that follows the default sheet already.
const MATCHING = { NORMAL_TEXT: { font: TNR, size: 12, alignment: 'JUSTIFIED', spaceAbove: 0, spaceBelow: 0 },
  HEADING_1: { font: TNR, size: 16, spaceAbove: 18, spaceBelow: 0, alignment: 'START' }, HEADING_2: { font: TNR, size: 14, spaceAbove: 14, spaceBelow: 0, alignment: 'START' },
  HEADING_3: { font: TNR, size: 12, spaceAbove: 12, spaceBelow: 0, alignment: 'START' }, HEADING_4: { font: TNR, size: 12, spaceAbove: 12, spaceBelow: 0, alignment: 'START' },
  HEADING_5: { font: TNR, size: 12, spaceAbove: 12, spaceBelow: 0, alignment: 'START' }, HEADING_6: { font: TNR, size: 12, spaceAbove: 12, spaceBelow: 0, alignment: 'START' },
  TITLE: { alignment: 'START' }, SUBTITLE: { alignment: 'START' } };

const tnr = (weight = 400) => ({ fontFamily: TNR, weight });
const pt = (n) => ({ magnitude: n, unit: 'PT' });
// above null: Docs' value is the sheet's already (Heading 5 and 6: 12 pt).
const heading = (n, size, above) => ({ updateNamedStyle: { namedStyle: { namedStyleType: `HEADING_${n}`, textStyle: { weightedFontFamily: tnr(), ...(size ? { fontSize: pt(size) } : {}) },
  paragraphStyle: { ...(above != null ? { spaceAbove: pt(above) } : {}), spaceBelow: pt(0), alignment: 'START' } },
fields: `namedStyleType,textStyle.weightedFontFamily,${size ? 'textStyle.fontSize,' : ''}${above != null ? 'paragraphStyle.spaceAbove,' : ''}paragraphStyle.spaceBelow,paragraphStyle.alignment`, tabId: 't.0' } });
const pinned = (type) => ({ updateNamedStyle: { namedStyle: { namedStyleType: type, paragraphStyle: { alignment: 'START' } }, fields: 'namedStyleType,paragraphStyle.alignment', tabId: 't.0' } });
// The requests for the default sheet on a new Docs document (Arial 11, Docs' heading sizes and spacing).
const DEFAULT_REQUESTS = [
  { updateNamedStyle: { namedStyle: { namedStyleType: 'NORMAL_TEXT', textStyle: { weightedFontFamily: tnr(), fontSize: pt(12) }, paragraphStyle: { alignment: 'JUSTIFIED' } },
    fields: 'namedStyleType,textStyle.weightedFontFamily,textStyle.fontSize,paragraphStyle.alignment', tabId: 't.0' } },
  heading(1, 16, 18), heading(2, 14, 14), heading(3, 12, 12), heading(4, 0, 12), heading(5, 12, null), heading(6, 12, null),
  pinned('TITLE'), pinned('SUBTITLE'),
];

test('document_styles: the definition is strict and short; read is a reading call, apply a write; offered with the Docs API in every mode', async () => {
  await fresh(short());
  const def = T.EXTRA_TOOLS.find((t) => t.names.includes('document_styles')).defs[0].function;
  deq(def.parameters, { type: 'object', properties: { action: { type: 'string', enum: ['read', 'apply', 'page'] }, page: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
    required: ['action', 'page'], additionalProperties: false });
  assert.ok(def.description.length < 340, def.description);
  deq([T.isExtraReading('document_styles', { action: 'read' }), T.isExtraReading('document_styles', { action: 'apply' }), T.isExtraReading('document_styles', { action: 'page' })], [true, false, false]);
  for (const mode of ['edit', 'manual', 'plan']) assert.ok(T.toolsFor(mode, as).some((t) => t.function.name === 'document_styles'), mode);
  assert.ok(!T.toolsFor('edit', { ...as, docFormat: 'markdown', model: null }).some((t) => t.function.name === 'document_styles'));
  // apply outside Auto is refused like every write
  const m = await T.executeTool({ id: 'm1', type: 'function', function: { name: 'document_styles', arguments: '{"action":"apply"}' } }, 'manual', as);
  assert.match(m.content, /^Error: the document cannot be modified here/);
  deq(posts().length, 0);
});

test('read: every style as it shows, "(differs)" where the sheet differs, the sheet in force once; no suffix on a matching document', async () => {
  await fresh(short());
  const r = await read();
  assert.ok(r._ok && r._reading, r.content);
  deq(r.content.split('\n'), [
    'Normal text: Arial 11 left space 0/0 (differs)',
    'Heading 1: Arial 20 left space 20/6 (differs)',
    'Heading 2: Arial 16 left space 18/6 (differs)',
    // Docs' grey on Heading 3-6 and Subtitle (a colour is no sheet value: it makes no style differ); black is not named
    'Heading 3: Arial 14 color #434343 left space 16/4 (differs)',
    'Heading 4: Arial 12 color #666666 left space 14/4 (differs)',
    'Heading 5: Arial 11 color #666666 left space 12/4 (differs)',
    'Heading 6: Arial 11 italic color #666666 left space 12/4 (differs)',
    'Title: Arial 26 left space 0/3',
    'Subtitle: Arial 15 color #666666 left space 0/16',
    'Page: Letter portrait margins 2.54 cm header 1.27 cm footer 1.27 cm first page number 1',
    'Sheet in force: Formatting: body Times New Roman 12 justify space 0/0; h1 16 space 18/0 keep-with-next; h2 14 space 14/0 keep-with-next; h3 12 space 12/0 keep-with-next; h4 12 space 12/0 keep-with-next; h5 12 space 12/0 keep-with-next; h6 12 space 12/0 keep-with-next (the default)',
  ]);
  deq(posts().length, 0);
  await fresh({ ...short(), namedStyles: MATCHING });
  const m = await read();
  assert.ok(!m.content.includes('(differs)'), m.content);
  assert.match(m.content, /^Normal text: Times New Roman 12 justify space 0\/0\nHeading 1: Times New Roman 16 left space 18\/0\n/);
  // the sheet's source: DOC.md
  as.docInstructions = 'Formatting: body Georgia 11';
  assert.match((await read()).content, /\nSheet in force: Formatting: body Georgia 11 justify space 0\/0; h1 16 space 18\/0 keep-with-next; .* \(from DOC\.md\)$/);
});

test('apply: one batch of updateNamedStyle with leaf masks for the default sheet on an Arial document; colors kept; verified; "No change" next', async () => {
  await fresh(short());
  const r = pushTool(await apply('ns1'));
  assert.ok(r._ok, r.content);
  deq(r.content, 'Done: set the document\'s styles to the formatting sheet (Normal text: Times New Roman 12 justify space 0/0; Heading 1: 16 space 18/0 keep-with-next; ' +
    'Heading 2: 14 space 14/0 keep-with-next; Heading 3: 12 space 12/0 keep-with-next; Heading 4: 12 space 12/0 keep-with-next; Heading 5: 12 space 12/0 keep-with-next; Heading 6: 12 space 12/0 keep-with-next).');
  deq(posts().length, 1);
  const body = posts()[0].body;
  deq(body.requests, DEFAULT_REQUESTS);
  assert.strictEqual(body.writeControl, undefined); // a named style has no index a concurrent edit could move
  const named = fake.named('t.0');
  deq(named.NORMAL_TEXT, { font: TNR, size: 12, color: '#000000', alignment: 'JUSTIFIED' }); // Docs sets Normal text's black
  deq(named.HEADING_3, { font: TNR, size: 12, color: '#434343', alignment: 'START', spaceAbove: 12, spaceBelow: 0 }); // the grey stays
  deq(r._edit.kind, 'named-styles');
  deq(r._message, 'Set the document styles to the formatting sheet');
  // the panel's model has the new revision: the next write is not refused
  const ins = pushTool(await exec('insert_after_line', { line: 3, text: 'Third.', style: null }));
  assert.ok(ins._ok, ins.content);
  const again = await apply('ns2');
  deq([again.content, again._ok, again._edit], ['No change: the document\'s styles already follow the formatting sheet.', true, undefined]);
  deq(posts().length, 2);
  await fresh({ ...short(), namedStyles: MATCHING });
  assert.match((await apply('ns3')).content, /^No change: /);
  deq(posts().length, 0);
});

test('apply: undo restores the former values exactly (a later insert undone first; a style changed meanwhile blocks it)', async () => {
  await fresh(short());
  const was = fake.named('t.0');
  pushTool(await apply('nu1'));
  pushTool(await exec('insert_after_line', { line: 3, text: 'Third.', style: null }));
  const u1 = await undo();
  assert.match(u1.content, /^Done: undid "Inserted/);
  deq(fake.text('t.0'), 'Intro\nFirst body paragraph.\nSecond.');
  const u2 = await undo();
  assert.match(u2.content, /^Done: restored the document's named styles \(Normal text, Heading 1, Heading 2, Heading 3, Heading 4, Heading 5, Heading 6, Title, Subtitle\)\./);
  deq(fake.named('t.0'), was);
  // a style the user changed in Docs after the edit: not overwritten
  await fresh(short());
  pushTool(await apply('nu2'));
  fake.tabs[0].named.HEADING_1.textStyle.fontSize = { magnitude: 30, unit: 'PT' };
  const blocked = pushTool(await exec('undo_last_edit', {}));
  assert.ok(!blocked._ok);
  assert.match(blocked.content, /the named style Heading 1 changed after that edit, so it cannot be undone automatically/);
});

test('apply: Google refuses updateNamedStyle (400): "Not available", remembered for the session (no second request)', async () => {
  await fresh({ ...short(), noNamedStyleUpdate: true });
  const r = await apply('nf1');
  assert.ok(!r._ok);
  assert.match(r.content, /^Not available: Google Docs did not accept the named-style update \(Invalid JSON payload received\. Unknown name "updateNamedStyle".*\)\. The sheet is still applied to each paragraph the assistant writes\.$/);
  deq(posts().length, 1);
  const again = await apply('nf2');
  assert.match(again.content, /^Not available: /);
  deq(posts().length, 1);
  // the writes go on with their per-paragraph sheet values
  const ins = await exec('insert_after_line', { line: 3, text: 'Third.', style: null });
  assert.ok(ins._ok, ins.content);
  deq(fake.fmt('t.0')[3], [[0, 6, { font: TNR, size: 12 }]]);
});

test('apply: Manual asks first with the whole summary (a document-wide formatting change like apply_sheet); Deny leaves the styles; Auto asks nothing', async () => {
  await fresh(short());
  as.askEdits = true;
  const p = apply('ng1');
  await waitFor(() => T.pendingPreviews.size === 1, 'the gate card');
  const [[id, card]] = [...T.pendingPreviews.entries()];
  assert.ok(card.card.innerHTML.includes('<div class="pv-note">Changes the document&#39;s named styles or page setup.</div><div class="pv-anchor">Named styles</div>') ||
    card.card.innerHTML.includes('<div class="pv-note">Changes the document\'s named styles or page setup.</div><div class="pv-anchor">Named styles</div>'), card.card.innerHTML);
  assert.ok(T.decidePreview(id, 'reject'));
  const r = await p;
  assert.ok(!r._ok);
  deq(posts().length, 0);
  deq(T.editGateInfo('document_styles', { summary: 'Normal text: x' }), { what: 'changes the document\'s named styles or page setup', range: 'Named styles', excerptLabel: 'Styles', excerpt: 'Normal text: x',
    blocks: [{ label: 'Styles', text: 'Normal text: x' }] });
  // Auto, in a tainted turn too: no card (the panel undoes it; the model asks the user before apply)
  await fresh(short());
  as.tainted = true;
  const auto = await apply('ng2');
  assert.ok(auto._ok && auto._decision === undefined && T.pendingPreviews.size === 0, auto.content);
});

const NOTE_RE = /\nNote: the document's named styles differ from the formatting sheet \(Normal text: Arial 11 left space 0\/0; 6 more\)\. Do not change them unasked; if the user may want them aligned, ask with ask_user first, then document_styles apply\.$/;
test('the first write of a visible turn leaves the named styles alone and notes once per turn that they differ; undo undoes the write', async () => {
  await fresh(short());
  as.readFirst = true;
  const r = pushTool(await exec('insert_after_line', { line: 3, text: 'Third.', style: null }, 'a1'));
  assert.ok(r._ok, r.content);
  assert.match(r.content, NOTE_RE);
  deq(r.content.split('\n').filter((l) => /named styles/.test(l)).length, 1);
  deq(fake.named('t.0').NORMAL_TEXT.font, 'Arial'); // never set by itself
  deq(posts().map((p) => Object.keys(p.body.requests[0])[0]), ['insertText']);
  assert.ok(!('_namedStyles' in r));
  // once per turn
  const r2 = pushTool(await exec('insert_after_line', { line: 4, text: 'Fourth.', style: null }, 'a2'));
  assert.ok(!r2.content.includes('named styles'), r2.content);
  deq(fake.log.filter((x) => x.method === 'GET' && /namedStyles/.test(decodeURIComponent(x.url))).length, 1); // one read per turn
  // undo goes to the writes, nothing else is in the journal
  const u = await undo();
  assert.match(u.content, /^Done: undid "Inserted/);
  deq(T.latestUndoable(state.messages), r);
  await undo();
  deq(fake.text('t.0'), 'Intro\nFirst body paragraph.\nSecond.');
  deq(fake.named('t.0').NORMAL_TEXT.font, 'Arial');
  // a new turn notes again
  as = T.takeSnapshot(); T.snapshotDocument(as); as.readFirst = true;
  assert.match((await exec('insert_after_line', { line: 3, text: 'x', style: null })).content, NOTE_RE);
});

test('the note only after a write that adds or formats paragraphs; a replace or a text-only format stays quiet and leaves it for a later one', async () => {
  await fresh(short());
  as.readFirst = true;
  const quiet = [
    ['replace_text', { old_text: 'Second.', new_text: 'Second one.' }],
    ['replace_all', { old_text: 'First', new_text: 'Opening' }],
    ['format_text', { old_text: 'Opening', bold: true, italic: null, underline: null }],
    ['edit_document', { operations: [{ op: 'replace', old_text: 'body', new_text: 'main' }, { op: 'format_text', old_text: 'Second', italic: true }] }],
  ];
  for (const [name, args] of quiet) {
    const r = pushTool(await exec(name, args));
    assert.ok(r._ok && !r.content.includes('named styles'), `${name}: ${r.content}`);
  }
  deq(fake.log.filter((x) => x.method === 'GET' && /namedStyles/.test(decodeURIComponent(x.url))).length, 0); // not even read
  // the first one that formats paragraphs in this turn gets it
  assert.match(pushTool(await exec('edit_document', { operations: [{ op: 'format_lines', start: 3, end: 3, style: 'h2' }] })).content, /named styles differ/);
  // each kind of such write, in a new turn on the short document
  const writes = [
    ['insert_after_line', { line: 3, text: 'Third.', style: null }],
    ['format_lines', { start: 1, end: 1, style: null, align: 'center', list: null, indent_start: null, indent_first_line: null, space_above: null, space_below: null, line_spacing: null, numbers: null }],
    ['edit_document', { operations: [{ op: 'insert', line: 1, text: 'Lead.', style: null }] }],
  ];
  for (const [name, args] of writes) {
    await fresh(short());
    as.readFirst = true;
    const r = pushTool(await exec(name, args));
    assert.ok(r._ok && /named styles differ/.test(r.content), `${name}: ${r.content}`);
  }
  // a section rewritten with text gives its paragraphs the sheet (it always asks first, so it is checked here); emptying
  // one adds nothing
  deq([T.sheetWrite('replace_section', { heading: 'Intro', new_text: 'New text.' }), T.sheetWrite('replace_section', { heading: 'Intro', new_text: '' }),
    T.sheetWrite('edit_document', { operations: [{ op: 'number_headings', numbers: 'set' }] }), T.sheetWrite('edit_document', { operations: '[{"op":"replace"}]' })], [true, false, true, false]);
});

test('after an explicit apply, undo_last_edit restores the styles first and then undoes the write before it; the Undo button too', async () => {
  await fresh(short());
  state.messages = [{ role: 'user', content: 'go' }, { role: 'assistant', content: null, tool_calls: [{ id: 'b1', type: 'function', function: { name: 'insert_after_line', arguments: '{}' } }, { id: 'b2', type: 'function', function: { name: 'document_styles', arguments: '{}' } }] }];
  const w = pushTool(await exec('insert_after_line', { line: 3, text: 'Third.', style: null }, 'b1'));
  const a = pushTool(await apply('b2'));
  assert.ok(w._ok && a._ok, a.content);
  deq(T.answerEdits('b2').length, 2);
  deq(T.answerEdits('b1').length, 0); // not the most recent
  assert.ok(await T.undoEditOf('b2')); // the Undo button's undo (undoFromButton without the chat lock)
  deq([a._edit.undone, w._edit.undone, fake.named('t.0').NORMAL_TEXT.font], [true, false, 'Arial']);
  assert.match(a.content, /\[Later the user undid this edit with the Undo button\.\]$/);
  assert.ok(!w.content.includes('Later'));
  await undo();
  deq([w._edit.undone, fake.text('t.0')], [true, 'Intro\nFirst body paragraph.\nSecond.']);
  deq(T.latestUndoable(state.messages), null);
});

test('the note: not with a Formatting line in DOC.md, not for a document with its own formatting, not outside visible turns, not when the styles match; a short document is not touched', async () => {
  const note = 'named styles differ';
  // DOC.md recorded the document's own line
  await fresh(short());
  as.readFirst = true; as.docInstructions = 'Formatting: body Arial 11 left space 0/0';
  assert.ok(!(await exec('insert_after_line', { line: 3, text: 'x', style: null })).content.includes(note));
  // the first-run measure finds formatting of the document's own (enough text in Arial)
  await fresh(docSpec());
  as.readFirst = true;
  const own = await exec('insert_after_line', { line: 10, text: 'x', style: null });
  assert.ok(own._ok && !own.content.includes(note), own.content);
  deq(fake.named('t.0').NORMAL_TEXT.font, 'Arial');
  // a call outside a visible turn (an agent, the self-test, the panel's own calls: no readFirst)
  await fresh(short());
  assert.ok(!(await exec('insert_after_line', { line: 3, text: 'x', style: null })).content.includes(note));
  as.readFirst = true; as.agent = { access: 'edit' };
  assert.ok(!(await exec('insert_after_line', { line: 3, text: 'y', style: null })).content.includes(note));
  delete as.agent;
  // matching styles: nothing said
  await fresh({ ...short(), namedStyles: MATCHING });
  as.readFirst = true;
  assert.ok(!(await exec('insert_after_line', { line: 3, text: 'x', style: null })).content.includes(note));
  // a short document (too little text for the measure) with differing styles: noted, never written
  await fresh(short());
  as.readFirst = true;
  for (const [k, t] of [[3, 'a'], [4, 'b'], [5, 'c']]) assert.ok((await exec('insert_after_line', { line: k, text: t, style: null })).content);
  deq(posts().filter((p) => p.body.requests.some((q) => q.updateNamedStyle)).length, 0);
  deq(fake.named('t.0').NORMAL_TEXT, { font: 'Arial', size: 11, color: '#000000', alignment: 'START' });
  // Google refused updateNamedStyle in this session: no note (apply would not work)
  T.namedStylesSession.unavailable = 'refused';
  as = T.takeSnapshot(); T.snapshotDocument(as); as.readFirst = true;
  assert.ok(!(await exec('insert_after_line', { line: 3, text: 'd', style: null })).content.includes(note));
});

// The next batchUpdate fails with f (the named-style read before it goes through).
const failPost = (f) => {
  const orig = fake.fetch;
  fake.fetch = async (url, init = {}) => {
    if ((init.method || 'GET') === 'POST') { fake.fetch = orig; fake.failNext = f; }
    return orig(url, init);
  };
};
test('apply: a 403 marks updateNamedStyle unavailable; another 400 (a request of ours Docs rejects) is an ordinary error and leaves it available', async () => {
  await fresh(short());
  failPost({ status: 400, message: 'Invalid requests[0].updateNamedStyle: Invalid value at paragraphStyle.alignment' });
  const r = await apply('e1');
  assert.ok(!r._ok);
  assert.match(r.content, /the named styles were not changed: .*Invalid value at paragraphStyle\.alignment.*\. Check them with document_styles read; if apply fails again, tell the user/);
  deq(T.namedStylesSession.unavailable, '');
  assert.ok((await apply('e2'))._ok);
  await fresh(short());
  failPost({ status: 403, message: 'The caller does not have permission' });
  const f = await apply('e3');
  assert.match(f.content, /^Not available: Google Docs did not accept the named-style update \(The caller does not have permission\)/);
  assert.match(T.namedStylesSession.unavailable, /permission/);
});

test('planNamedStyles: a right-to-left document reads and writes the alignment in its direction (left = END)', () => {
  const rtl = { NORMAL_TEXT: { textStyle: { weightedFontFamily: { fontFamily: TNR, weight: 400 }, fontSize: pt(12) }, paragraphStyle: { alignment: 'END', direction: 'RIGHT_TO_LEFT' } },
    HEADING_1: { textStyle: {}, paragraphStyle: { alignment: 'START' } } }; // right, in the body's direction
  deq(T.namedStyleValues(rtl).NORMAL_TEXT.align, 'left');
  const sheet = T.resolveStyleSheet('Formatting: body Times New Roman 12 right; h1 Times New Roman 16 left', '');
  const plan = T.planNamedStyles(rtl, sheet, 't.0');
  const req = (type) => plan.requests.find((q) => q.updateNamedStyle.namedStyle.namedStyleType === type).updateNamedStyle.namedStyle.paragraphStyle;
  deq(req('NORMAL_TEXT').alignment, 'START'); // right in RTL
  deq(req('HEADING_1').alignment, 'END'); // left in RTL
  deq(req('HEADING_2').alignment, 'END'); // pinned to the body's former left when the body's alignment moves
  // a matching RTL document: nothing to write for the body's alignment
  const same = T.planNamedStyles(rtl, T.resolveStyleSheet('Formatting: body Times New Roman 12 left', ''), 't.0');
  assert.ok(!same.types.includes('NORMAL_TEXT'));
});

test('the formatting view\'s "Unmarked text" follows the Normal text style after an update', async () => {
  await fresh(short());
  await read(); // the named styles are read: unformatted text is Normal text, Arial 11
  const before = await exec('read_document', { scope: { start: 1, end: 3 }, include: ['formatting'], doc: null });
  assert.match(before.content.split('\n')[0], / Unmarked text: Arial 11\.$/);
  await apply('fh1');
  const after = await exec('read_document', { scope: { start: 1, end: 3 }, include: ['formatting'], doc: null });
  assert.match(after.content.split('\n')[0], / Unmarked text: Times New Roman 12\.$/);
});
