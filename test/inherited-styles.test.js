'use strict';
// Inserted text takes the text style of its neighbour in Google Docs (development/tools/real-docs.js facts 7b, 7e): the
// character before the index in its paragraph, at a paragraph's start the one at the index; a link does not pass on, nor
// its underline and color. The fake does the same (spec.inheritStyle: false turns it off). So insert_after_line resets
// what its new paragraphs would take, and an undo writes the removed text back with its own text styles.
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

const spec = (items, more = {}) => ({ documentId: 'DOC123', title: 'Doc', tabs: [{ id: 't.0', title: 'Main', items }], ...more });
const LINK = 'https://example.org/';
const ins = (index, text) => ({ insertText: { location: { index, tabId: 't.0' }, text } });
const post = (f, requests) => f.fetch('https://docs.googleapis.com/v1/documents/DOC123:batchUpdate', { method: 'POST', headers: { Authorization: 'Bearer tok-1' }, body: JSON.stringify({ requests }) });
const fmt = () => fake.fmt('t.0');

test('fake Docs: inserted text takes the style before it, at a paragraph start the one after it; links do not pass on', async () => {
  const items = [{ p: 'Bold start', fmt: [[0, 4, { bold: true }]] }, { p: 'Link here', fmt: [[0, 4, { link: LINK, underline: true, color: '#1155CC', italic: true }]] },
    { p: '' }, { p: 'Size word', fmt: [[5, 9, { size: 15 }]] }];
  // 1..11 "Bold start", 12..21 "Link here", 22 "", 23..32 "Size word"
  const f = fakeDocsServer(spec(items));
  assert.strictEqual((await post(f, [ins(32, '\nnext'), ins(22, 'E'), ins(16, 'ed'), ins(12, 'Z'), ins(5, 'Y'), ins(1, 'X')])).status, 200);
  deq(f.text('t.0').split('\n'), ['XBoldY start', 'ZLinked here', 'E', 'Size word', 'next']);
  deq(f.fmt('t.0'), [[[0, 6, { bold: true }]], [[0, 1, { italic: true }], [1, 5, { link: LINK, underline: true, color: '#1155CC', italic: true }], [5, 7, { italic: true }]], [],
    [[5, 9, { size: 15 }]], [[0, 4, { size: 15 }]]]);
  // spec.inheritStyle false: plain, as the fake was before
  const g = fakeDocsServer(spec(items, { inheritStyle: false }));
  await post(g, [ins(5, 'Y')]);
  deq(g.fmt('t.0')[0], [[0, 4, { bold: true }]]);
});

test('insert_after_line: new paragraphs start plain, whatever the line before ends in', async () => {
  await fresh(spec([{ p: 'Plain then italic end', fmt: [[18, 21, { italic: true, color: '#FF0000' }]] }, { p: 'Closing.' }]));
  const w = pushTool(await exec('insert_after_line', { line: 1, text: 'Inserted one.\nInserted two.', style: null }, 'i1'));
  assert.ok(w._ok, w.content);
  // the reset right after the insert: the fields the new text would take (the sheet writes font and size itself)
  deq(lastPost().requests[1], { updateTextStyle: { range: { startIndex: 23, endIndex: 50, tabId: 't.0' }, textStyle: {}, fields: 'italic,foregroundColor' } });
  deq(fmt().slice(1, 3).map((x) => x.filter(([, , st]) => st.italic || st.color)), [[], []]);
  deq(fmt()[0], [[18, 21, { italic: true, color: '#FF0000' }]]);
  // a plain line before: no reset
  await fresh(spec([{ p: 'Plain line.' }, { p: 'Closing.' }]));
  pushTool(await exec('insert_after_line', { line: 1, text: 'Inserted.', style: null }, 'i2'));
  assert.ok(!lastPost().requests.some((q) => q.updateTextStyle && !Object.keys(q.updateTextStyle.textStyle).length), JSON.stringify(lastPost().requests));
});

test('undo puts removed text back with its own text styles, not its neighbour\'s', async () => {
  // (bold as Docs stores it: with the font the text shows, so restoring it stores nothing new)
  // delete_lines of a middle line: restored at the start of the italic line after it
  await fresh(spec([{ p: 'Intro.' }, { p: 'Middle with bold word and a link.', fmt: [[12, 16, { bold: true, font: 'Arial' }], [27, 31, { link: LINK, underline: true, color: '#1155CC' }]] },
    { p: 'Next italic line.', fmt: [[0, 17, { italic: true }]] }]));
  const before = fmt();
  assert.ok(pushTool(await exec('delete_lines', { start: 2, end: 2 }, 'd1'))._ok);
  assert.ok(pushTool(await exec('undo_last_edit', {}, 'd1u'))._ok);
  deq(fake.text('t.0').split('\n'), ['Intro.', 'Middle with bold word and a link.', 'Next italic line.']);
  deq(fmt(), before);
  assert.ok(lastPost().requests.some((q) => q.updateTextStyle && q.updateTextStyle.textStyle.bold), JSON.stringify(lastPost().requests));
  // replace_text of a whole bold word: the new word takes the deleted word's bold (Docs: real-docs.js fact 7f); undo too
  const B = { bold: true, font: 'Arial' };
  await fresh(spec([{ p: 'A bold word here.', fmt: [[2, 6, B]] }]));
  assert.ok(pushTool(await exec('replace_text', { old_text: 'bold', new_text: 'strong' }, 'r1'))._ok);
  deq(fmt()[0], [[2, 8, B]]);
  assert.ok(pushTool(await exec('undo_last_edit', {}, 'r1u'))._ok);
  deq(fmt()[0], [[2, 6, B]]);
  // a plain word replaced right after a bold one takes the plain style of what it replaces, not the bold before it
  await fresh(spec([{ p: 'A boldword here.', fmt: [[2, 6, B]] }]));
  assert.ok(pushTool(await exec('replace_text', { old_text: 'word', new_text: 'term' }, 'r2'))._ok);
  deq(fake.text('t.0'), 'A boldterm here.');
  deq(fmt()[0], [[2, 6, B]]);
  // replace_all: each occurrence comes back with its own styles (a partly italic one; a plain one after a bold word)
  await fresh(spec([{ p: 'One colour here.', fmt: [[4, 7, { italic: true }]] }, { p: 'Bold colour too.', fmt: [[5, 11, B]] }, { p: 'Bold, colour plain.', fmt: [[0, 4, B]] }]));
  const ra = fmt();
  const w = pushTool(await exec('replace_all', { old_text: 'colour', new_text: 'shade' }, 'ra1'));
  assert.ok(w._ok, w.content);
  deq(w._edit.restoreStyles.map((x) => x.map(([s, e, st]) => [s, e, !!st.italic, !!st.bold])), [[[0, 3, true, false]], [[0, 6, false, true]], []]);
  assert.ok(pushTool(await exec('undo_last_edit', {}, 'ra1u'))._ok);
  deq(fake.text('t.0').split('\n'), ['One colour here.', 'Bold colour too.', 'Bold, colour plain.']);
  deq(fmt(), ra);
  // plain removed text next to a plain neighbour: the undo sends no text style
  await fresh(spec([{ p: 'One.' }, { p: 'Two.' }, { p: 'Three.' }]));
  assert.ok(pushTool(await exec('delete_lines', { start: 2, end: 2 }, 'd2'))._ok);
  assert.ok(pushTool(await exec('undo_last_edit', {}, 'd2u'))._ok);
  deq(lastPost().requests.map((q) => Object.keys(q)[0]), ['insertText']);
});
