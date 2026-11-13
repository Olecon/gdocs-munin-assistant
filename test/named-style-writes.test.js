'use strict';
// A namedStyleType write and the text styles of the runs, as the real Docs API showed them (development/tools/real-docs.js
// facts 7b, 7c, 7d, 7e): a write that changes no paragraph's named style clears the text styles of every paragraph in its
// range (links and baselineOffset stay); one that changes the style clears the fields that cover a whole line; a merge
// keeps the paragraph the deletion starts in when text of it stays before the range. The fake models this, and the
// write plans send a named style only where Docs would leave another one (restyle), so a write and its undo keep the
// bold, italic, fonts and links of the lines they do not restyle.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installIdentity } = require('./lib/sandbox');
const { docsBench, fakeDocsServer } = require('./lib/fake-docs');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let fresh, exec, pushTool, lastPost;

before(async () => {
  const env = await load();
  ({ fresh, exec, pushTool, lastPost } = docsBench(env, installIdentity(env), ref));
  env.state.settings.provider = 'anthropic'; env.state.googleConnected = true;
});

const spec = (items) => ({ documentId: 'DOC123', title: 'Doc', tabs: [{ id: 't.0', title: 'Main', items }] });
const rng = (s, e) => ({ startIndex: s, endIndex: e, tabId: 't.0' });
const named = (s, e, style) => ({ updateParagraphStyle: { range: rng(s, e), paragraphStyle: { namedStyleType: style }, fields: 'namedStyleType' } });
const kinds = () => lastPost().requests.map((q) => Object.keys(q)[0]);
const namedSent = () => lastPost().requests.some((q) => q.updateParagraphStyle && /namedStyleType/.test(q.updateParagraphStyle.fields));
const fmt = () => fake.fmt('t.0');
const NULLS = { style: null, align: null, list: null, indent_start: null, indent_first_line: null, space_above: null, space_below: null, line_spacing: null };
const LINK = 'https://example.org/';
const BLUE = { underline: true, color: '#1155CC' }; // a link's own style (Docs adds it)

function post(f, requests) {
  return f.fetch('https://docs.googleapis.com/v1/documents/DOC1:batchUpdate', { method: 'POST', headers: { Authorization: 'Bearer tok-1' }, body: JSON.stringify({ requests }) });
}
const raw = (items) => fakeDocsServer({ ...spec(items), documentId: 'DOC1' });

test('fake Docs: the same named style clears every text style of the paragraphs in the range; links and scripts stay', async () => {
  const f = raw([
    { p: 'a word bold', fmt: [[2, 6, { bold: true }]] }, // 1..12
    { p: 'b word link', fmt: [[2, 6, { link: LINK, ...BLUE, bold: true }]] }, // 13..24
    { p: 'c word sup', fmt: [[2, 6, { script: 'super', italic: true, font: 'Georgia', size: 14, color: '#FF0000', bg: '#FFFF00', underline: true }]] }, // 25..35
    { p: 'd word kept', fmt: [[2, 6, { bold: true }]] }, // 36..47
  ]);
  // one character of each of the first two lines and the whole third: each paragraph is cleared, the next one is not touched
  assert.strictEqual((await post(f, [named(1, 2, 'NORMAL_TEXT'), named(16, 17, 'NORMAL_TEXT'), named(25, 35, 'NORMAL_TEXT')])).status, 200);
  deq(f.fmt('t.0'), [[], [[2, 6, { link: LINK, ...BLUE }]], [[2, 6, { script: 'super' }]], [[2, 6, { bold: true }]]]);
  // a mask with other fields too: the same
  const g = raw([{ p: 'Heading here', style: 'HEADING_2', fmt: [[0, 7, { bold: true }]] }]);
  await post(g, [{ updateParagraphStyle: { range: rng(1, 13), paragraphStyle: { namedStyleType: 'HEADING_2', alignment: 'CENTER' }, fields: 'namedStyleType,alignment' } }]);
  deq(g.fmt('t.0'), [[]]);
  // without namedStyleType in the mask nothing is cleared
  const h = raw([{ p: 'Kept bold', fmt: [[0, 4, { bold: true }]] }]);
  await post(h, [{ updateParagraphStyle: { range: rng(1, 10), paragraphStyle: { alignment: 'CENTER' }, fields: 'alignment' } }]);
  deq(h.fmt('t.0'), [[[0, 4, { bold: true }]]]);
});

test('fake Docs: another named style clears what covers the whole line, field by field; the unchanged paragraphs of the request keep all', async () => {
  const f = raw([
    { p: 'Whole bold, word italic', fmt: [[0, 23, { bold: true }], [6, 10, { italic: true }]] }, // 1..24
    { p: 'Bold but the first', fmt: [[1, 18, { bold: true }]] }, // 25..43
    { p: 'Linked whole line', fmt: [[0, 17, { link: LINK }]] }, // 44..61
    { p: 'Sized and super', fmt: [[0, 15, { size: 13, script: 'super', font: 'Georgia' }]] }, // 62..77
  ]);
  assert.strictEqual((await post(f, [named(1, 77, 'HEADING_2')])).status, 200);
  deq(f.fmt('t.0'), [[[6, 10, { italic: true }]], [[1, 18, { bold: true }]], [[0, 17, { link: LINK }]], [[0, 15, { script: 'super' }]]]);
  // one request over three lines where only the heading changes: the two body lines keep everything
  const g = raw([{ p: 'M1 heading', style: 'HEADING_2' }, { p: 'M2 whole bold', fmt: [[0, 13, { bold: true }]] }, { p: 'M3 word', fmt: [[3, 7, { italic: true }]] }]);
  await post(g, [named(1, 33, 'NORMAL_TEXT')]);
  deq(g.styles('t.0'), ['NORMAL_TEXT', 'NORMAL_TEXT', 'NORMAL_TEXT']);
  deq(g.fmt('t.0'), [[], [[0, 13, { bold: true }]], [[3, 7, { italic: true }]]]);
});

test('fake Docs: a merge keeps the paragraph the deletion starts in when its text stays, else the one it ends in', async () => {
  const items = [{ p: 'Upper heading', style: 'HEADING_1', pstyle: { alignment: 'CENTER' } }, { p: 'lower body' }, { p: '' }, { p: 'After empty', style: 'HEADING_3' },
    { p: 'Item', bullet: { listId: 'l', level: 0 } }, { p: 'plain' }];
  const f = raw(items);
  // back to front: the item's newline (the item keeps its bullet), the empty line's newline (the H3 survives), the heading's
  await post(f, [{ deleteContentRange: { range: rng(43, 44) } }, { deleteContentRange: { range: rng(26, 27) } }, { deleteContentRange: { range: rng(14, 15) } }]);
  deq(f.text('t.0').split('\n'), ['Upper headinglower body', 'After empty', 'Itemplain']);
  deq(f.styles('t.0'), ['HEADING_1', 'HEADING_3', 'NORMAL_TEXT']);
  deq(f.pstyles('t.0')[0], { alignment: 'CENTER' });
  assert.ok(f.bullets('t.0')[2]);
  // from a paragraph's start: the paragraph the range ends in survives
  const g = raw(items);
  await post(g, [{ deleteContentRange: { range: rng(1, 21) } }]);
  deq(g.text('t.0').split('\n')[0], 'body');
  deq(g.styles('t.0')[0], 'NORMAL_TEXT');
});

test('replace_text that splits a line keeps its bold and link; no named style is sent, the undo sends none either', async () => {
  await fresh(spec([{ p: 'Intro with bold word and a link to the end.', fmt: [[11, 15, { bold: true }], [27, 31, { link: LINK }]] }, { p: 'Next line.' }]));
  const w = pushTool(await exec('replace_text', { old_text: 'to the end.', new_text: 'to the end.\nA new second paragraph.' }, 'r1'));
  assert.ok(w._ok, w.content);
  assert.ok(!namedSent(), JSON.stringify(lastPost().requests));
  deq(fake.text('t.0').split('\n'), ['Intro with bold word and a link to the end.', 'A new second paragraph.', 'Next line.']);
  deq(fmt()[0].filter(([, , st]) => st.bold || st.link).map(([s, e, st]) => [s, e, Object.keys(st).sort()]), [[11, 15, ['bold']], [27, 31, ['link']]]);
  assert.ok(pushTool(await exec('undo_last_edit', {}, 'r1u'))._ok);
  assert.ok(!namedSent(), JSON.stringify(lastPost().requests));
  deq(fake.text('t.0').split('\n'), ['Intro with bold word and a link to the end.', 'Next line.']);
  deq(fmt()[0].filter(([, , st]) => st.bold).map(([s, e]) => [s, e]), [[11, 15]]);
  // a merge of two lines keeps both lines' formatting (the first line's style survives: nothing to send)
  await fresh(spec([{ p: 'Methods', style: 'HEADING_1', fmt: [[0, 7, { italic: true }]] }, { p: 'Body with bold.', fmt: [[10, 14, { bold: true }]] }]));
  const m = pushTool(await exec('replace_text', { old_text: 'Methods\nBody', new_text: 'Methods. Body' }, 'r2'));
  assert.ok(m._ok, m.content);
  deq(kinds(), ['deleteContentRange', 'insertText']);
  deq(fake.styles('t.0'), ['HEADING_1']);
  // the inserted ". " takes the italic of the character before it (real Docs: real-docs.js fact 7c, "*Methods. *Body")
  deq(fmt()[0].filter(([, , st]) => st.italic || st.bold).map(([s, e, st]) => [s, e, st.italic ? 'i' : 'b']), [[0, 9, 'i'], [19, 23, 'b']]);
  // its undo splits the line again: the second half copies the heading's style, so Normal text is set on it alone
  assert.ok(pushTool(await exec('undo_last_edit', {}, 'r2u'))._ok);
  deq(lastPost().requests.filter((q) => q.updateParagraphStyle), [named(9, 10, 'NORMAL_TEXT')]);
  deq(fake.styles('t.0'), ['HEADING_1', 'NORMAL_TEXT']);
  deq(fmt(), [[[0, 7, { italic: true }]], [[10, 14, { bold: true }]]]);
});

test('delete_lines of the last line keeps the bold of the line before; so does its undo', async () => {
  await fresh(spec([{ p: 'Title', style: 'TITLE' }, { p: 'Body with bold word here.', fmt: [[10, 14, { bold: true }]] }, { p: 'Last line to delete.' }]));
  const w = pushTool(await exec('delete_lines', { start: 3, end: 3 }, 'd1'));
  assert.ok(w._ok, w.content);
  deq(kinds(), ['deleteContentRange']);
  deq(fmt()[1], [[10, 14, { bold: true }]]);
  assert.ok(pushTool(await exec('undo_last_edit', {}, 'd1u'))._ok);
  assert.ok(!namedSent(), JSON.stringify(lastPost().requests));
  deq(fake.text('t.0').split('\n'), ['Title', 'Body with bold word here.', 'Last line to delete.']);
  deq(fake.styles('t.0'), ['TITLE', 'NORMAL_TEXT', 'NORMAL_TEXT']);
  deq(fmt()[1], [[10, 14, { bold: true }]]);
  // after an empty line the deleted line's style would survive: the empty line's own is set back
  await fresh(spec([{ p: 'Body', fmt: [[0, 4, { bold: true }]] }, { p: '' }, { p: 'Closing heading', style: 'HEADING_2' }]));
  assert.ok(pushTool(await exec('delete_lines', { start: 3, end: 3 }, 'd2'))._ok);
  deq(lastPost().requests[1], named(6, 7, 'NORMAL_TEXT'));
  deq(fake.styles('t.0'), ['NORMAL_TEXT', 'NORMAL_TEXT']);
  deq(fmt()[0], [[0, 4, { bold: true }]]);
});

test('format_lines: a line that has the style already gets no named style (its text styles stay); a restyled line\'s undo writes them back', async () => {
  const items = [{ p: 'Heading', style: 'HEADING_2' }, { p: 'Body with bold word.', fmt: [[10, 14, { bold: true }]] }, { p: 'Another in italic.', fmt: [[11, 17, { italic: true }]] }];
  await fresh(spec(items));
  // style normal and justify over two body lines: both are normal text already
  let w = pushTool(await exec('format_lines', { start: 2, end: 3, ...NULLS, style: 'normal', align: 'justify' }, 'f1'));
  assert.ok(w._ok, w.content);
  assert.ok(!namedSent(), JSON.stringify(lastPost().requests));
  deq(fmt().slice(1).map((x) => x.filter(([, , st]) => st.bold || st.italic).map(([s, e]) => [s, e])), [[[10, 14]], [[11, 17]]]);
  assert.ok(pushTool(await exec('undo_last_edit', {}, 'f1u'))._ok);
  assert.ok(!namedSent(), JSON.stringify(lastPost().requests));
  deq(fmt().slice(1), [[[10, 14, { bold: true }]], [[11, 17, { italic: true }]]]);
  // h2 over the heading (already h2, a bold word added) and a line that is bold as a whole: only that line is restyled
  // (bold as Docs stores it: with the font the text shows)
  await fresh(spec([{ p: 'Heading', style: 'HEADING_2', fmt: [[0, 4, { bold: true, font: 'Arial' }]] }, { p: 'All bold line', fmt: [[0, 13, { bold: true, color: '#FF0000', font: 'Arial' }]] }, { p: 'After.' }]));
  w = pushTool(await exec('format_lines', { start: 1, end: 2, ...NULLS, style: 'h2', align: 'center' }, 'f2'));
  assert.ok(w._ok, w.content);
  const ps = lastPost().requests.filter((q) => q.updateParagraphStyle).map((q) => [q.updateParagraphStyle.range.startIndex, q.updateParagraphStyle.fields]);
  assert.ok(ps.some(([s, f]) => s === 1 && f === 'alignment') && ps.some(([s, f]) => s === 9 && /namedStyleType/.test(f)), JSON.stringify(ps));
  deq(fake.styles('t.0'), ['HEADING_2', 'HEADING_2', 'NORMAL_TEXT']);
  deq(fmt()[0].filter(([, , st]) => st.bold).map(([s, e]) => [s, e]), [[0, 4]]); // the heading's bold word stays
  assert.ok(!fmt()[1].some(([, , st]) => st.color), JSON.stringify(fmt()[1])); // Docs clears a whole line's color on a style change (the sheet's h2 writes bold)
  assert.ok(pushTool(await exec('undo_last_edit', {}, 'f2u'))._ok);
  deq(fake.styles('t.0'), ['HEADING_2', 'NORMAL_TEXT', 'NORMAL_TEXT']);
  deq(fmt()[0], [[0, 4, { bold: true, font: 'Arial' }]]);
  deq(fmt()[1], [[0, 13, { bold: true, color: '#FF0000', font: 'Arial' }]]);
});

test('insert_after_line with an outline: a run of lines in the style they copy gets no named style', async () => {
  await fresh(spec([{ p: 'Intro with bold end', fmt: [[15, 19, { bold: true }]] }, { p: 'Closing.' }]));
  const w = pushTool(await exec('insert_after_line', { line: 1, text: 'Plain first line\n# A heading\nPlain again', style: 'outline' }, 'o1'));
  assert.ok(w._ok, w.content);
  const styled = lastPost().requests.filter((q) => q.updateParagraphStyle && q.updateParagraphStyle.fields === 'namedStyleType').map((q) => q.updateParagraphStyle.paragraphStyle.namedStyleType);
  assert.ok(!styled.includes('NORMAL_TEXT') && styled.length === 1, JSON.stringify(styled));
  deq(fmt()[0], [[15, 19, { bold: true }]]);
});
