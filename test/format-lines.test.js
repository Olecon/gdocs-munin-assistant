'use strict';
// format_lines: the schema, every argument's request and field mask, loose values, grouping across a table cell,
// RTL alignment, the tab refusal, lists (create, change with nesting kept, remove with the indent reset) with
// undo and its note, no-op and the same-turn repeat guard, every error text, and keepsLines (an
// insert_after_line may follow a format_lines in the same response).
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, installIdentity } = require('./lib/sandbox');
const { docSpec, docsBench } = require('./lib/fake-docs');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, fresh, exec, pushTool, lastPost, FNOTE;

before(async () => {
  env = await load();
  T = env.T;
  state = env.state;
  const ident = installIdentity(env);
  ({ fresh, exec, pushTool, lastPost } = docsBench(env, ident, ref));
  installDocTab(env);
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic'; state.googleConnected = true;
  FNOTE = T.FORMAT_NOTE;
});

// Lines: 1 Title, 2 Alpha, 3 Beta, 4 Gamma, 5 Cell A, 6 Cell B (a table), 7 After, 8 "\tTabbed",
// 9-10 a bulleted list (level 0, level 1), 11 Last.
const spec = () => docSpec({ items: [
  { p: 'Title', style: 'TITLE' },
  { p: 'Alpha' }, { p: 'Beta' }, { p: 'Gamma' },
  { table: [[[{ p: 'Cell A' }], [{ p: 'Cell B' }]]] },
  { p: 'After' },
  { p: '\tTabbed' },
  { p: 'Nested one', bullet: { listId: 'kix.b', level: 0, preset: 'BULLET_DISC_CIRCLE_SQUARE' } },
  { p: 'Nested two', bullet: { listId: 'kix.b', level: 1 } },
  { p: 'Last' },
] });
const NULLS = { style: null, align: null, list: null, indent_start: null, indent_first_line: null, space_above: null, space_below: null, line_spacing: null };
const fl = (start, end, over) => ({ start, end, ...NULLS, ...over });
const range = (s, e) => ({ startIndex: s, endIndex: e, tabId: 't.0' });
const pstyle = (s, e, paragraphStyle, fields) => ({ updateParagraphStyle: { range: range(s, e), paragraphStyle, fields } });
const posts = () => fake.log.filter((x) => x.method === 'POST').length;
const pt = (n) => ({ magnitude: n, unit: 'PT' });
const INDENTS = 'indentStart,indentFirstLine';
// A new turn on the current document (the repeat guard is per turn).
const newTurn = () => { as = T.takeSnapshot(); T.snapshotDocument(as); };

test('schema: ten required properties, strict, nullable enums; a write tool that keeps line numbers', async () => {
  const p = T.TOOL_DEFS.format_lines.function.parameters;
  deq(p.required, ['start', 'end', 'style', 'align', 'list', 'indent_start', 'indent_first_line', 'space_above', 'space_below', 'line_spacing']);
  assert.strictEqual(p.additionalProperties, false);
  deq(Object.keys(p.properties), p.required);
  deq(p.properties.style.anyOf, [{ type: 'string', enum: ['title', 'subtitle', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'normal'] }, { type: 'null' }]);
  deq(p.properties.list.anyOf, [{ type: 'string', enum: ['bullet', 'number', 'checklist', 'none'] }, { type: 'null' }]);
  deq(p.properties.line_spacing, { anyOf: [{ type: 'number' }, { type: 'null' }], description: 'Line spacing as a multiplier: 1, 1.15, 1.5, 2.' });
  assert.strictEqual(T.TOOL_DEFS.format_lines.function.description, 'Paragraph formatting of whole lines start..end: heading style, alignment, list, indents, spacing. Every property: null = leave as it is. The text does not change. Returns the lines as they look now. Main document only.');
  assert.ok(T.WRITE_TOOLS.includes('format_lines') && T.LINE_NUMBER_TOOLS.includes('format_lines'));
  assert.strictEqual(T.EDIT_TOOL_ICONS.format_lines, '📐');
});

test('every argument: its exact request and field mask, the result in notation, exact undo', async () => {
  await fresh(spec());
  deq(as.model.lines.map((l) => [l.start, l.end]), [[1, 6], [7, 12], [13, 17], [18, 23], [27, 33], [35, 41], [42, 47], [48, 55], [56, 66], [67, 77], [78, 82]]);
  const cases = [
    [{ style: 'h2' }, { namedStyleType: 'HEADING_2' }, 'namedStyleType', '[h2] Alpha', 'h2'],
    [{ align: 'center' }, { alignment: 'CENTER' }, 'alignment', '[center] Alpha', 'centered'],
    [{ align: 'justify' }, { alignment: 'JUSTIFIED' }, 'alignment', '[justify] Alpha', 'justified'],
    [{ indent_start: 36 }, { indentStart: pt(36) }, 'indentStart', '[indent 36/-] Alpha', 'indent 36'],
    [{ indent_first_line: 18 }, { indentFirstLine: pt(18) }, 'indentFirstLine', '[indent -/18] Alpha', 'first line at 18'],
    [{ space_above: 12 }, { spaceAbove: pt(12) }, 'spaceAbove', '[space 12/-] Alpha', 'space above 12'],
    [{ space_below: 6 }, { spaceBelow: pt(6) }, 'spaceBelow', '[space -/6] Alpha', 'space below 6'],
    [{ line_spacing: 1.15 }, { lineSpacing: 115 }, 'lineSpacing', '[line 1.15] Alpha', 'line spacing 1.15'],
  ];
  for (const [over, ps, fields, tagged, how] of cases) {
    const w = pushTool(await exec('format_lines', fl(2, 2, over)));
    assert.ok(w._ok, w.content);
    deq(lastPost().requests, [pstyle(7, 13, ps, fields)]);
    assert.strictEqual(w.content, `Done: formatted line 2 (${how}).\n${FNOTE}\nLines 2-2 now:\n2: ${tagged}\nThe document now has 11 lines.`);
    assert.strictEqual(w._message, 'Formatted line 2');
    assert.strictEqual(w._cardLabel, 'Formatted lines'); assert.strictEqual(w._cardText, 'Alpha');
    const u = pushTool(await exec('undo_last_edit', {}));
    assert.ok(u._ok, u.content);
    assert.ok(!u.content.includes('re-created'), u.content); // no list involved
    deq(fake.pstyles('t.0')[1], {}); assert.strictEqual(fake.styles('t.0')[1], 'NORMAL_TEXT');
  }
  // indents of 0 send magnitude 0 (not a reset)
  pushTool(await exec('format_lines', fl(3, 3, { indent_start: 0 })));
  deq(lastPost().requests, [pstyle(13, 18, { indentStart: pt(0) }, 'indentStart')]);
  pushTool(await exec('undo_last_edit', {}));

  // all at once on two lines: one request, the fields joined in a fixed order; undo: one inverse per stretch
  const w = pushTool(await exec('format_lines', fl(2, 3, { style: 'h2', align: 'center', indent_start: 36, indent_first_line: 18, space_above: 12, space_below: 6, line_spacing: 1.5 }), 'all'));
  const fields = 'namedStyleType,alignment,indentStart,indentFirstLine,spaceAbove,spaceBelow,lineSpacing';
  deq(lastPost().requests, [pstyle(7, 18, { namedStyleType: 'HEADING_2', alignment: 'CENTER', indentStart: pt(36), indentFirstLine: pt(18), spaceAbove: pt(12), spaceBelow: pt(6), lineSpacing: 150 }, fields)]);
  assert.strictEqual(w.content, `Done: formatted lines 2–3 (h2, centered, indent 36, first line at 18, space above 12, space below 6, line spacing 1.5).\n${FNOTE}\n` +
    'Lines 2-3 now:\n2: [h2 center indent 36/18 space 12/6 line 1.5] Alpha\n3: [h2 center indent 36/18 space 12/6 line 1.5] Beta\nThe document now has 11 lines.');
  deq(w._edit, { id: 'all', docId: 'DOC123', tabId: 't.0', kind: 'format', index: 7, end: 18, text: 'Alpha\nBeta', restore: '', paras: [],
    requests: [pstyle(7, 18, { namedStyleType: 'NORMAL_TEXT' }, fields)], title: 'Formatted lines 2–3', undone: false,
    anchor: { before: 'Title\n', after: '\nGamma\nCell A\nCell B', revision: 'rev-' + fake.revision } });
  deq(fake.pstyles('t.0').slice(1, 3), [{ alignment: 'CENTER', indentStart: 36, indentFirstLine: 18, spaceAbove: 12, spaceBelow: 6, lineSpacing: 150 }, { alignment: 'CENTER', indentStart: 36, indentFirstLine: 18, spaceAbove: 12, spaceBelow: 6, lineSpacing: 150 }]);
  const u = pushTool(await exec('undo_last_edit', {}));
  assert.strictEqual(u.content, `Done: undid formatting of lines 2–3.\n${FNOTE}\nLines 2-3 now:\n2: Alpha\n3: Beta\nThe document now has 11 lines.`);
  deq(fake.pstyles('t.0').slice(1, 3), [{}, {}]); deq(fake.styles('t.0').slice(0, 4), ['TITLE', 'NORMAL_TEXT', 'NORMAL_TEXT', 'NORMAL_TEXT']);

  // prior values that differ per line: one inverse per stretch of equal values, absent ones reset
  await fresh(docSpec({ items: [{ p: 'One', style: 'HEADING_1', pstyle: { alignment: 'END', spaceAbove: 4 } }, { p: 'Two', pstyle: { alignment: 'END', spaceAbove: 4 } }, { p: 'Three' }] }));
  const x = pushTool(await exec('format_lines', fl(1, 3, { style: 'h3', align: 'left', space_above: 0 })));
  deq(x._edit.requests, [
    pstyle(1, 5, { namedStyleType: 'HEADING_1', alignment: 'END', spaceAbove: pt(4) }, 'namedStyleType,alignment,spaceAbove'),
    pstyle(5, 9, { namedStyleType: 'NORMAL_TEXT', alignment: 'END', spaceAbove: pt(4) }, 'namedStyleType,alignment,spaceAbove'),
    pstyle(9, 15, { namedStyleType: 'NORMAL_TEXT' }, 'namedStyleType,alignment,spaceAbove'),
  ]);
  pushTool(await exec('undo_last_edit', {}));
  deq(fake.pstyles('t.0'), [{ alignment: 'END', spaceAbove: 4 }, { alignment: 'END', spaceAbove: 4 }, {}]);
  deq(fake.styles('t.0'), ['HEADING_1', 'NORMAL_TEXT', 'NORMAL_TEXT']);
});

test('loose values: names, strings with units, percent line spacing (with a note), a missing key is null', async () => {
  await fresh(spec());
  let w = pushTool(await exec('format_lines', { start: '2', end: 2, style: 'Heading 2', align: 'centre', list: null, indent_start: '36pt', indent_first_line: 'null', space_above: '', line_spacing: '150%' }));
  assert.ok(w._ok, w.content);
  deq(lastPost().requests, [pstyle(7, 13, { namedStyleType: 'HEADING_2', alignment: 'CENTER', indentStart: pt(36), lineSpacing: 150 }, 'namedStyleType,alignment,indentStart,lineSpacing')]);
  assert.ok(w.content.endsWith('\nNote: line_spacing 150% was read as a percent (1.5).'), w.content);
  pushTool(await exec('undo_last_edit', {}));
  w = pushTool(await exec('format_lines', { start: 3, end: 3, line_spacing: 115 }));
  deq(lastPost().requests, [pstyle(13, 18, { lineSpacing: 115 }, 'lineSpacing')]);
  assert.strictEqual(w.content, `Done: formatted line 3 (line spacing 1.15).\n${FNOTE}\nLines 3-3 now:\n3: [line 1.15] Beta\nThe document now has 11 lines.\nNote: line_spacing 115 was read as a percent (1.15).`);
  w = pushTool(await exec('format_lines', { start: 4, end: 4, style: '##', list: 'numbered' }));
  deq(fake.styles('t.0')[3], 'HEADING_2'); deq(fake.bullets('t.0')[3].preset, 'NUMBERED_DECIMAL_ALPHA_ROMAN');
  assert.ok(w.content.startsWith('Done: formatted line 4 (h2, numbered list).'), w.content);
});

test('every validation error text; nothing is written', async () => {
  await fresh(docSpec({ items: [{ p: 'One' }, { p: 'Two', suggest: true }, { p: 'Three' }, { p: '\tTabbed' }] }));
  const err = async (args) => { const w = await exec('format_lines', args); assert.strictEqual(w._ok, false, w.content); return [w.content, w._message]; };
  deq(await err(fl(0, 1, { style: 'h1' })), ['Error: start and end must be integers with 1 <= start <= end <= 4', 'format_lines: invalid range']);
  deq((await err(fl(2, 1, { style: 'h1' })))[0], 'Error: start and end must be integers with 1 <= start <= end <= 4');
  deq((await err(fl(1, 5, { style: 'h1' })))[0], 'Error: start and end must be integers with 1 <= start <= end <= 4');
  deq((await err(fl(1.5, 2, { style: 'h1' })))[0], 'Error: start and end must be integers with 1 <= start <= end <= 4');
  deq(await err(fl(1, 1, {})), ['Error: pass at least one of style, align, list, indent_start, indent_first_line, space_above, space_below, line_spacing (null leaves it unchanged). Example: {"start":3,"end":3,"style":"h1","align":null,"list":null,"indent_start":null,"indent_first_line":null,"space_above":null,"space_below":null,"line_spacing":null}', 'format_lines: no formatting given']);
  deq((await err({ start: 1, end: 1 }))[1], 'format_lines: no formatting given');
  deq(await err(fl(1, 1, { style: 'Heading One' })), ['Error: style must be one of title, subtitle, h1…h6, normal (got "Heading One")', 'format_lines: invalid style']);
  deq((await err(fl(1, 1, { style: 7 })))[0], 'Error: style must be one of title, subtitle, h1…h6, normal (got 7)');
  deq(await err(fl(1, 1, { align: 'diagonal' })), ['Error: align must be left, center, right or justify', 'format_lines: invalid align']);
  deq(await err(fl(1, 1, { list: 'dots' })), ['Error: list must be bullet, number, checklist or none', 'format_lines: invalid list']);
  deq(await err(fl(1, 1, { indent_start: 601 })), ['Error: indent_start must be a number of points from 0 to 600', 'format_lines: invalid indent_start']);
  deq((await err(fl(1, 1, { indent_first_line: -1 })))[0], 'Error: indent_first_line must be a number of points from 0 to 600');
  deq((await err(fl(1, 1, { space_above: 201 })))[0], 'Error: space_above must be a number of points from 0 to 200');
  deq((await err(fl(1, 1, { space_below: 'lots' })))[0], 'Error: space_below must be a number of points from 0 to 200');
  deq((await err(fl(1, 1, { space_below: true })))[0], 'Error: space_below must be a number of points from 0 to 200');
  for (const v of [0.4, 6, 600, 'double']) {
    deq(await err(fl(1, 1, { line_spacing: v })), ['Error: line_spacing must be a multiplier from 0.5 to 5 (1 = single, 1.5, 2)', 'format_lines: invalid line_spacing']);
  }
  deq(await err(fl(1, 3, { align: 'center' })), ['Error: line 2 contains suggested changes (suggesting mode); accept or reject them in Google Docs first', 'format_lines: the line has suggested changes']);
  deq(await err(fl(3, 4, { list: 'bullet' })), ['Error: line 4 starts with a tab, which Google Docs turns into list nesting and deletes. Remove the tab first with replace_text, or leave that line out.', 'format_lines: a line starts with a tab']);
  as.model.lines[0].exact = false;
  deq(await err(fl(1, 1, { align: 'center' })), ['Error: the positions in line 1 cannot be mapped exactly', 'format_lines: unmappable line']);
  as.model.lines[0].exact = true;
  assert.strictEqual(posts(), 0);
  // the tab refusal is about lists only: other properties format the line
  const w = await exec('format_lines', fl(4, 4, { align: 'right' }));
  assert.ok(w._ok, w.content);
  deq(lastPost().requests, [pstyle(15, 23, { alignment: 'END' }, 'alignment')]);
});

test('groups: contiguous index ranges; a table cell ends a group; undo per group', async () => {
  await fresh(spec());
  const w = pushTool(await exec('format_lines', fl(4, 7, { align: 'right' }), 'grp'));
  assert.ok(w._ok, w.content);
  deq(lastPost().requests, [pstyle(42, 48, { alignment: 'END' }, 'alignment'), pstyle(35, 42, { alignment: 'END' }, 'alignment'),
    pstyle(27, 34, { alignment: 'END' }, 'alignment'), pstyle(18, 24, { alignment: 'END' }, 'alignment')]);
  deq(fake.pstyles('t.0').slice(3, 7).map((p) => p.alignment), ['END', 'END', 'END', 'END']);
  assert.ok(w.content.includes('\n4: [right] Gamma\n[table T1: 1 row × 2 columns, lines 5–6]\n5 [r1c1]: [right] Cell A\n6 [r1c2]: [right] Cell B\n7: [right] After\n'), w.content);
  // the anchor text is the first group's line; the inverse covers every group
  deq([w._edit.index, w._edit.end, w._edit.text], [18, 48, 'Gamma']);
  assert.strictEqual(w._edit.requests.length, 4);
  const u = pushTool(await exec('undo_last_edit', {}));
  assert.ok(u._ok, u.content);
  assert.ok(u.content.startsWith('Done: undid formatting of lines 4–7.'), u.content);
  deq(fake.pstyles('t.0').slice(3, 7), [{}, {}, {}, {}]);
  // a list across the cells: bullets per group
  pushTool(await exec('format_lines', fl(5, 6, { list: 'bullet' })));
  deq(lastPost().requests, [{ createParagraphBullets: { range: range(35, 42), bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' } },
    { createParagraphBullets: { range: range(27, 34), bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' } }]);
  deq(fake.bullets('t.0').slice(4, 6).map((b) => b && b.preset), ['BULLET_DISC_CIRCLE_SQUARE', 'BULLET_DISC_CIRCLE_SQUARE']);
});

test('alignment in right-to-left paragraphs: left and right swap, one request per direction', async () => {
  await fresh(docSpec({ items: [{ p: 'ltr' }, { p: 'rtl', pstyle: { direction: 'RIGHT_TO_LEFT' } }, { p: 'ltr2' }] }));
  const w = pushTool(await exec('format_lines', fl(1, 3, { align: 'left' })));
  deq(lastPost().requests, [pstyle(1, 5, { alignment: 'START' }, 'alignment'), pstyle(5, 9, { alignment: 'END' }, 'alignment'), pstyle(9, 14, { alignment: 'START' }, 'alignment')]);
  assert.ok(w.content.includes('\n1: ltr\n2: rtl\n3: ltr2\n'), w.content); // left is not tagged
  pushTool(await exec('undo_last_edit', {}));
  deq(fake.pstyles('t.0'), [{}, { direction: 'RIGHT_TO_LEFT' }, {}]);
});

test('lists: create, change kind keeping nesting, remove with the indent reset; undo with the note', async () => {
  await fresh(spec());
  const NOTE = 'Note: the list was re-created; numbering, custom bullets or ticks may differ.';
  // create on plain lines: no deleteParagraphBullets, no paragraph style
  let w = pushTool(await exec('format_lines', fl(2, 4, { list: 'number' }), 'mk'));
  deq(lastPost().requests, [{ createParagraphBullets: { range: range(7, 24), bulletPreset: 'NUMBERED_DECIMAL_ALPHA_ROMAN' } }]);
  assert.strictEqual(w.content, `Done: formatted lines 2–4 (numbered list).\n${FNOTE}\nLines 2-4 now:\n2: [number] Alpha\n3: [number] Beta\n4: [number] Gamma\nThe document now has 11 lines.`);
  assert.strictEqual(w._edit.lists, true);
  deq(w._edit.requests, [{ deleteParagraphBullets: { range: range(7, 24) } }, pstyle(7, 24, {}, INDENTS)]);
  // remove: bullets off and the indents Docs leaves reset in one paragraph-style request
  w = pushTool(await exec('format_lines', fl(2, 4, { list: 'none' }), 'rm'));
  deq(lastPost().requests, [{ deleteParagraphBullets: { range: range(7, 24) } }, pstyle(7, 24, {}, INDENTS)]);
  assert.ok(w.content.includes('Lines 2-4 now:\n2: Alpha\n3: Beta\n4: Gamma\n'), w.content);
  deq(fake.pstyles('t.0').slice(1, 4), [{}, {}, {}]); deq(fake.bullets('t.0').slice(1, 4), [null, null, null]);
  const listId = (n) => as.model.lines[n - 1].list && as.model.lines[n - 1].list.listId;
  // undo of the removal re-creates the numbered list (a new list) with its indents
  let u = pushTool(await exec('undo_last_edit', {}));
  assert.ok(u.content.startsWith(`Done: undid formatting of lines 2–4.\n${NOTE}\n${FNOTE}\nLines 2-4 now:\n2: [number] Alpha\n`), u.content);
  deq(fake.pstyles('t.0')[1], { indentStart: 36, indentFirstLine: 18 });
  // undo of the creation: plain again
  u = pushTool(await exec('undo_last_edit', {}));
  assert.ok(u.content.includes(NOTE) && u.content.includes('\n2: Alpha\n3: Beta\n4: Gamma\n'), u.content);
  deq(fake.bullets('t.0').slice(1, 4), [null, null, null]); deq(fake.pstyles('t.0').slice(1, 4), [{}, {}, {}]);
  assert.strictEqual(listId(2), null);

  // change the kind of a nested list: delete, a tab for level 1, create over the range plus the tab
  w = pushTool(await exec('format_lines', fl(9, 10, { list: 'checklist' }), 'chg'));
  deq(lastPost().requests, [{ deleteParagraphBullets: { range: range(56, 78) } }, { insertText: { location: { index: 67, tabId: 't.0' }, text: '\t' } },
    { createParagraphBullets: { range: range(56, 79), bulletPreset: 'BULLET_CHECKBOX' } }]);
  assert.ok(w.content.includes('\n9: [checklist] Nested one\n10: [checklist L2] Nested two\n'), w.content);
  assert.strictEqual(fake.text('t.0').split('\n')[9], 'Nested two'); // the tab went into the level
  deq(w._edit.requests, [{ deleteParagraphBullets: { range: range(56, 78) } }, { insertText: { location: { index: 67, tabId: 't.0' }, text: '\t' } },
    { createParagraphBullets: { range: range(56, 79), bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' } }, pstyle(56, 78, {}, INDENTS)]);
  u = pushTool(await exec('undo_last_edit', {}));
  assert.ok(u.content.includes(NOTE) && u.content.includes('\n9: [bullet] Nested one\n10: [bullet L2] Nested two\n'), u.content);
  deq(fake.bullets('t.0').slice(8, 10).map((b) => [b.level, b.preset]), [[0, 'BULLET_DISC_CIRCLE_SQUARE'], [1, 'BULLET_DISC_CIRCLE_SQUARE']]);
  deq(fake.pstyles('t.0').slice(8, 10), [{}, {}]); // the spec's list had no explicit indents

  // none with an indent given: that indent is set, the other one reset
  w = pushTool(await exec('format_lines', fl(9, 10, { list: 'none', indent_start: 10 })));
  deq(lastPost().requests, [{ deleteParagraphBullets: { range: range(56, 78) } }, pstyle(56, 78, { indentStart: pt(10) }, INDENTS)]);
  deq(fake.pstyles('t.0').slice(8, 10), [{ indentStart: 10 }, { indentStart: 10 }]);
  assert.ok(w.content.includes('\n9: [indent 10/-] Nested one\n10: [indent 10/-] Nested two\n'), w.content);
  // explicit indents with a list: after the bullets, so they win
  pushTool(await exec('undo_last_edit', {}));
  w = pushTool(await exec('format_lines', fl(2, 3, { list: 'bullet', indent_start: 50 })));
  deq(lastPost().requests, [{ createParagraphBullets: { range: range(7, 18), bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' } }, pstyle(7, 18, { indentStart: pt(50) }, 'indentStart')]);
  deq(fake.pstyles('t.0')[1], { indentStart: 50, indentFirstLine: 18 });
  deq(w._edit.requests, [{ deleteParagraphBullets: { range: range(7, 18) } }, pstyle(7, 18, {}, INDENTS)]);
  // a style write without lists says nothing about lists on undo
  w = pushTool(await exec('format_lines', fl(11, 11, { style: 'h3' })));
  assert.strictEqual(w._edit.lists, undefined);
});

test('no change and the same-turn repeat guard: nothing is sent, no journal entry', async () => {
  await fresh(spec());
  let n = posts();
  let w = await exec('format_lines', fl(1, 1, { style: 'title' }));
  assert.strictEqual(w.content, `No change: line 1 is already formatted like this (title).\n${FNOTE}\nLines 1-1 now:\n1: [title] Title`);
  deq([w._ok, w._message, w._edit], [true, 'No change: line 1', undefined]);
  w = await exec('format_lines', fl(2, 3, { list: 'none' }));
  assert.ok(w.content.startsWith('No change: lines 2–3 are already not in a list.\n'), w.content);
  w = await exec('format_lines', fl(9, 9, { list: 'bullet' }));
  assert.ok(w.content.startsWith('No change: line 9 is already a bulleted list.\n'), w.content);
  assert.strictEqual(posts(), n);
  // a success, then the same call in the same turn
  w = pushTool(await exec('format_lines', fl(2, 4, { list: 'number' })));
  assert.ok(w._ok && w._edit, w.content);
  n = posts();
  w = await exec('format_lines', fl(2, 4, { list: 'number' }));
  assert.strictEqual(w.content, `Already done in this message: formatted lines 2–4 (numbered list). Do not call format_lines again for this.\n${FNOTE}\nLines 2-4 now:\n2: [number] Alpha\n3: [number] Beta\n4: [number] Gamma`);
  deq([w._ok, w._message, w._edit], [true, 'Already done: formatted lines 2–4', undefined]);
  // the same values given loosely count as the same call
  w = await exec('format_lines', { start: 2, end: 4, list: 'numbered', style: 'null' });
  assert.ok(w.content.startsWith('Already done in this message:'), w.content);
  assert.strictEqual(posts(), n);
  // in the next turn: plain "No change"
  newTurn();
  w = await exec('format_lines', fl(2, 4, { list: 'number' }));
  assert.ok(w.content.startsWith('No change: lines 2–4 are already a numbered list.\n'), w.content);
  // after an undo in the same turn the call is not a repeat: it formats again
  w = pushTool(await exec('format_lines', fl(5, 5, { align: 'center' })));
  pushTool(await exec('undo_last_edit', {}));
  n = posts();
  w = pushTool(await exec('format_lines', fl(5, 5, { align: 'center' })));
  assert.ok(w._ok && w._edit && w.content.startsWith('Done: formatted line 5 (centered).'), w.content);
  assert.strictEqual(posts(), n + 1);
});

test('keepsLines: an insert_after_line may follow a format_lines in the same response; the reverse is refused', async () => {
  await fresh(spec());
  let w = pushTool(await exec('format_lines', fl(2, 2, { style: 'h1' }), 'k1'));
  assert.ok(w._ok, w.content);
  assert.strictEqual(as.responseWrite, null);
  w = pushTool(await exec('insert_after_line', { line: 3, text: 'Inserted' }, 'k2', true));
  assert.ok(w._ok, w.content);
  deq(fake.text('t.0').split('\n').slice(1, 5), ['Alpha', 'Beta', 'Inserted', 'Gamma']);
  // insert first: a format_lines with the old numbers is refused in the same response
  w = await exec('format_lines', fl(5, 5, { style: 'h1' }), 'k3', true);
  assert.ok(!w._ok && /line numbers changed after the previous edit in this response/.test(w.content), w.content);
  assert.strictEqual(w._message, 'format_lines: line numbers changed by the previous edit; not applied');
});

test('action log: format_lines summary names the lines and the change', () => {
  assert.strictEqual(T.toolCallSummary('format_lines', fl(4, 6, { list: 'numbered', align: 'center' })), 'lines 4–6 (numbered list, centered)');
  assert.strictEqual(T.toolCallSummary('format_lines', fl(2, 2, { style: 'Heading 2', space_above: '12pt', line_spacing: 115 })), 'line 2 (h2, space above 12, line spacing 1.15)');
  assert.strictEqual(T.toolCallSummary('format_lines', fl(3, 5, { list: 'none' })), 'lines 3–5 (no list)');
  assert.strictEqual(T.toolCallSummary('format_lines', fl(3, 5, { align: 'diagonal' })), 'lines 3–5'); // invalid: no words
});
