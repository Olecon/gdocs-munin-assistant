'use strict';
// What the writing tools tell the model after a write, from a saved chat where these texts cost half the rounds: a value
// a heading inherits counts as applied (the named styles are read once per turn when a check would report a miss), the
// format legend once per turn, format_text on a line's whole text formats the whole line, a heading style on a
// multi-line insert names the lines it made headings that read like body text, a refused edit_document says that none
// of its operations was applied, a no-op replace points to the formatting tools, a "not found" excerpt starts at a word.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installIdentity } = require('./lib/sandbox');
const { docSpec, docsBench } = require('./lib/fake-docs');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let fresh, exec, pushTool, lastPost, state;

before(async () => {
  const env = await load();
  state = env.state;
  ({ fresh, exec, pushTool, lastPost } = docsBench(env, installIdentity(env), ref));
  state.settings.provider = 'anthropic'; state.googleConnected = true;
});

const NONE = { line: null, all: null, bold: null, italic: null, underline: null, font: null, size: null, color: null, highlight: null, link: null };
const fmt = (old_text, props) => exec('format_text', { old_text, ...NONE, ...props });
const FT = (old_text, props) => ({ op: 'format_text', old_text, ...NONE, ...props });
const namedReads = () => fake.log.filter((x) => x.method === 'GET' && /namedStyles/.test(decodeURIComponent(x.url))).length;
const LEGEND = 'Markers are notation, not document text';
// The fake keeps a size equal to the one the named style gives out (dropInherited, as Docs): Heading 2 is 16 pt.
const headSpec = () => docSpec({ items: [
  { p: 'Body text here.' },
  { p: 'Discussion', style: 'HEADING_2', fmt: [[0, 10, { size: 15 }]] },
  { p: 'Results', style: 'HEADING_2', fmt: [[0, 7, { size: 15 }]] },
] });

test('format_text on a heading: a value equal to its named style\'s is applied, not a miss; the named styles are read once per turn, only on a miss', async () => {
  await fresh(headSpec());
  // no miss: nothing is read
  let w = await fmt('Body', { bold: true });
  assert.strictEqual(w.content, 'Done: formatted line 1 (bold on); the document has 3 lines.');
  assert.strictEqual(namedReads(), 0);
  // the heading's own size: Docs stores none, the re-read shows the style's 16 pt
  w = await fmt('Discussion', { size: 16 });
  assert.strictEqual(w.content, 'Done: formatted line 2 (size 16); the document has 3 lines.');
  assert.strictEqual(namedReads(), 1);
  // the same in edit_document, in the same turn: no second read
  w = await exec('edit_document', { operations: [FT('Results', { size: 16 }), FT('Body', { italic: true })] });
  assert.ok(w._ok && !/did not apply/.test(w.content), w.content);
  assert.strictEqual(namedReads(), 1);
  // a new turn reads again
  await fresh(headSpec());
  w = await fmt('Discussion', { size: 16 });
  assert.ok(w._ok && !/did not apply/.test(w.content), w.content);
  assert.strictEqual(namedReads(), 1);
});

test('format_text on a heading: when the named styles cannot be read the value is unknown and the note stays', async () => {
  await fresh(headSpec());
  const orig = fake.fetch;
  fake.fetch = async (url, init = {}) => {
    if ((init.method || 'GET') === 'GET' && /namedStyles/.test(decodeURIComponent(url))) throw new Error('offline');
    return orig(url, init);
  };
  const w = await fmt('Discussion', { size: 16 });
  fake.fetch = orig;
  assert.ok(w.content.startsWith('Done: formatted line 2 (size 16); the document has 3 lines.\nNote: Google Docs did not apply all of it (not shown: size 16); line 2 now reads:\n'), w.content);
});

// A server that drops bold from every text write: a real miss.
function dropBold() {
  const orig = fake.fetch;
  fake.fetch = async (url, init = {}) => {
    if ((init.method || 'GET') === 'POST' && /:batchUpdate/.test(url)) {
      const body = JSON.parse(init.body);
      for (const rq of body.requests) if (rq.updateTextStyle) delete rq.updateTextStyle.textStyle.bold;
      init = { ...init, body: JSON.stringify(body) };
    }
    return orig(url, init);
  };
  return () => { fake.fetch = orig; };
}

test('a real miss is still named; the legend comes once per turn, the later notes carry the lines without it', async () => {
  await fresh(headSpec());
  let undrop = dropBold();
  const a = await fmt('Body', { bold: true });
  const b = await fmt('Results', { bold: true });
  const c = await exec('edit_document', { operations: [FT('Discussion', { bold: true }), FT('text here', { bold: true })] });
  undrop();
  for (const w of [a, b, c]) assert.ok(/Note: Google Docs did not apply all of it \(not shown: bold on\); line \d now reads:/.test(w.content), w.content);
  const legends = (w) => w.content.split('\n').filter((l) => l.startsWith(LEGEND)).length;
  assert.deepStrictEqual([legends(a), legends(b), legends(c)], [1, 0, 0]);
  assert.ok(b.content.endsWith('now reads:\nLines 3-3 now:\n3: [h2] Results'), b.content);
  // the next turn shows it again
  await fresh(headSpec());
  undrop = dropBold();
  const d = await fmt('Body', { bold: true });
  undrop();
  assert.strictEqual(legends(d), 1, d.content);
});

const spaceSpec = () => docSpec({ items: [
  { p: 'Body text here.' },
  { p: ' Discussion', style: 'HEADING_2', fmt: [[0, 11, { font: 'Roboto', size: 15 }]] },
  { p: 'Results ', fmt: [[0, 8, { font: 'Roboto' }]] },
  { p: 'The Results section', fmt: [[0, 19, { font: 'Roboto' }]] },
] });
const range = () => { const r = lastPost().requests[0].updateTextStyle.range; return [r.startIndex, r.endIndex]; };
const line = (n) => as.model.lines[n - 1];

test('format_text with a line\'s whole text but its edge spaces formats the whole line, says so, and undoes as before', async () => {
  await fresh(spaceSpec());
  const before = JSON.stringify(fake.fmt('t.0'));
  let w = pushTool(await fmt('Discussion', { font: 'Times New Roman' }));
  assert.strictEqual(w.content, 'Done: formatted the whole line 2 (font Times New Roman); the document has 4 lines.');
  assert.deepStrictEqual(range(), [line(2).start, line(2).start + 11]);
  deq(fake.fmt('t.0')[1], [[0, 11, { font: 'Times New Roman', size: 15 }]]);
  w = await exec('undo_last_edit', {});
  assert.ok(w._ok, w.content);
  assert.strictEqual(JSON.stringify(fake.fmt('t.0')), before);
  // a trailing space; edit_document's operation too
  w = await exec('edit_document', { operations: [FT('Results', { line: 3, size: 12 })] });
  assert.ok(w._ok && w.content.includes('formatted the whole line 3 (size 12)'), w.content);
  assert.deepStrictEqual(range(), [line(3).start, line(3).start + 8]);
  // a word inside a line, underline (it shows on a space) and all: true format the text given
  w = await fmt('Results', { line: 4, size: 12 });
  assert.strictEqual(w.content, 'Done: formatted line 4 (size 12); the document has 4 lines.');
  w = await fmt('Discussion', { underline: true });
  assert.strictEqual(w.content, 'Done: formatted line 2 (underline on); the document has 4 lines.');
  assert.deepStrictEqual(range(), [line(2).start + 1, line(2).start + 11]);
  w = await fmt('Discussion', { all: true, italic: true });
  assert.ok(w._ok && !w.content.includes('whole'), w.content);
  assert.deepStrictEqual(range(), [line(2).start + 1, line(2).start + 11]);
});

const insertSpec = () => docSpec({ items: [{ p: 'Notes', style: 'HEADING_1' }, { p: 'Results', style: 'HEADING_2' }, { p: 'The yield was high.' }] });

test('a heading style on a multi-line insert: the lines made headings that are empty or read like body text are named with the way out', async () => {
  await fresh(insertSpec());
  let w = await exec('insert_after_line', { line: 3, text: 'Limitations\nOnly one enzyme batch was tested.\n\nOutlook', style: 'h3', fill: null });
  assert.strictEqual(w.content, 'Done: inserted after line 3; now lines 4–7; the document has 7 lines.\n'
    + 'Note: line 6 is empty and line 5 reads like body text, yet h3 now: format_lines style normal, or undo_last_edit and insert with style outline.');
  deq(as.model.lines.slice(3).map((l) => l.style), ['HEADING_3', 'HEADING_3', 'HEADING_3', 'HEADING_3']); // the style still covers every line
  // more than 12 words without a period; edit_document's insert
  await fresh(insertSpec());
  w = await exec('edit_document', { operations: [{ op: 'insert', line: 3, text: 'Scope\nWe tested one batch of the enzyme at three temperatures in two buffers and one pH', style: 'h2', fill: null }] });
  assert.ok(w._ok && w.content.endsWith('\nNote: line 5 reads like body text, yet h2 now: format_lines style normal, or undo_last_edit and insert with style outline.'), w.content);
  // headings typed as one block, one line, an outline: no note
  for (const [text, style] of [['Limitations\nOutlook', 'h3'], ['Only one enzyme batch was tested.', 'h3'], ['### Limitations\nOnly one enzyme batch was tested.\n\nMore.', 'outline']]) {
    await fresh(insertSpec());
    w = await exec('insert_after_line', { line: 3, text, style, fill: null });
    assert.ok(w._ok && !w.content.includes('like body text') && !w.content.includes('is empty'), w.content);
  }
});

test('edit_document refused for one operation: the error says that none was applied and all go again', async () => {
  await fresh(insertSpec());
  const ops = [{ op: 'replace', old_text: 'yield', new_text: 'Yield', line: null }, { op: 'replace', old_text: 'nowhere to be found', new_text: 'x', line: null },
    { op: 'format_lines', start: 1, end: 1, style: null, align: 'center', list: null, indent_start: null, indent_first_line: null, space_above: null, space_below: null, line_spacing: null, indent_end: null, box: null, page_break_before: null }];
  const posts = fake.log.filter((x) => x.method === 'POST').length;
  let w = await exec('edit_document', { operations: ops });
  assert.ok(!w._ok && w.content.startsWith('Error: operation 2 (replace «nowhere to be found»): old_text was not found'), w.content);
  assert.ok(w.content.endsWith('. No operation was applied; send all 3 again with this one fixed'), w.content);
  assert.strictEqual(fake.log.filter((x) => x.method === 'POST').length, posts);
  // one operation: the error as it was
  w = await exec('edit_document', { operations: [ops[1]] });
  assert.ok(!w._ok && !w.content.includes('No operation was applied'), w.content);
});

test('replace_text with its own text points to the formatting tools; a "not found" excerpt starts at a word', async () => {
  await fresh(docSpec({ items: [{ p: 'Methods', style: 'HEADING_1' }, { p: '3.2.2.3 Torsion scans of the dihedral angles.' }] }));
  let w = await exec('replace_text', { old_text: 'Methods', new_text: 'Methods', line: null });
  assert.strictEqual(w.content, 'No change: «Methods» already reads that; its look: format_text or format_lines.');
  w = await exec('replace_text', { old_text: '3.3 Torsion scans of the dihedral angles.', new_text: '3.4 Torsion scans of the dihedral angles.', line: null });
  assert.ok(w.content.startsWith('Error: old_text not found. Closest match at line 2: «3.2.2.3 Torsion scans of the dihedral angles.»; differs at «3» (old_text) vs «3.2.2» (document).\n'), w.content);
});
