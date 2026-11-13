'use strict';
// format_text and bold under a font change: Docs drops bold when weightedFontFamily is written (the real API,
// the owner's /test "Write: text styles"), applying weightedFontFamily first and then a bold of the same
// request. The fake models that; format_text re-applies the prior bold (one request when the range is all
// bold, a request per bold stretch otherwise) and its undo lists bold, so the prior styles come back exactly.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installIdentity } = require('./lib/sandbox');
const { docSpec, docsBench, fakeDocsServer } = require('./lib/fake-docs');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let T, fresh, exec, pushTool, lastPost;

before(async () => {
  const env = await load();
  T = env.T;
  ({ fresh, exec, pushTool, lastPost } = docsBench(env, installIdentity(env), ref));
  env.state.settings.provider = 'anthropic'; env.state.googleConnected = true;
});

const LINE = 'The slow green turtle jumps over the lazy dog.';
const NONE = { bold: null, italic: null, underline: null, font: null, size: null, color: null, highlight: null, link: null };
const fmtCall = (old_text, props, id) => exec('format_text', { old_text, ...NONE, ...props }, id);
// The line as a formatting view shows it (the named styles read when a run sets a font: a bold write stores Arial).
const marked = async () => { await T.knowUnmarkedFont(as); return T.markedText(as.model.lines[0], T.spanDefault(as.model)); };
const rng = (s, e) => ({ startIndex: s, endIndex: e, tabId: 't.0' });
const STYLES = { font: 'Courier New', size: 14, color: '#FF0000', highlight: '#FFFF00' };

test('fake Docs: a weightedFontFamily write drops bold; a bold in the same request is applied after it', async () => {
  const f = fakeDocsServer({ documentId: 'DOC1', title: 'Doc', tabs: [{ id: 't.0', title: 'Main', items: [{ p: 'Hello world', fmt: [[0, 11, { bold: true }]] }] }] });
  const post = (requests) => f.fetch('https://docs.googleapis.com/v1/documents/DOC1:batchUpdate',
    { method: 'POST', headers: { Authorization: 'Bearer tok-1' }, body: JSON.stringify({ requests }) });
  const wff = { weightedFontFamily: { fontFamily: 'Courier New', weight: 400 } };
  assert.strictEqual((await post([{ updateTextStyle: { range: rng(1, 6), textStyle: wff, fields: 'weightedFontFamily' } }])).status, 200);
  assert.strictEqual((await post([{ updateTextStyle: { range: rng(7, 12), textStyle: { ...wff, bold: true }, fields: 'bold,weightedFontFamily' } }])).status, 200);
  deq(f.fmt('t.0')[0], [[0, 5, { font: 'Courier New' }], [5, 6, { bold: true }], [6, 11, { font: 'Courier New', bold: true }]]);
  // a reset of the font drops bold too
  await post([{ updateTextStyle: { range: rng(7, 12), textStyle: {}, fields: 'weightedFontFamily' } }]);
  deq(f.fmt('t.0')[0], [[0, 5, { font: 'Courier New' }], [5, 6, { bold: true }]]);
});

test('format_text: bold, then font, size, colors, italic and underline on the same words keep bold; undo restores each step', async () => {
  await fresh(docSpec({ items: [{ p: LINE }] }));
  const off = LINE.indexOf('lazy dog');
  const s = as.model.lines[0].start + off;
  const plain = fake.fmt('t.0');
  assert.ok(pushTool(await fmtCall('lazy dog', { bold: true }, 'f1'))._ok);
  assert.strictEqual(await marked(),'The slow green turtle jumps over the **lazy dog**.');
  const bolded = fake.fmt('t.0');
  const w = pushTool(await fmtCall('lazy dog', { ...STYLES, italic: true, underline: true }, 'f2'));
  assert.ok(w._ok, w.content);
  // one request: bold re-sent with the font (applied after it by Docs)
  deq(lastPost().requests.length, 1);
  const u = lastPost().requests[0].updateTextStyle;
  assert.strictEqual(u.fields, 'italic,underline,weightedFontFamily,fontSize,foregroundColor,backgroundColor,bold');
  assert.strictEqual(u.textStyle.bold, true);
  deq(u.range, rng(s, s + 8));
  assert.strictEqual(await marked(),'The slow green turtle jumps over the {***__lazy dog__***}(font=Courier New size=14 color=#FF0000 bg=#FFFF00).');
  deq(fake.fmt('t.0')[0], [[off, off + 8, { bold: true, italic: true, underline: true, font: 'Courier New', size: 14, color: '#FF0000', bg: '#FFFF00' }]]);
  assert.ok((await exec('undo_last_edit', {}, 'u2'))._ok);
  deq(fake.fmt('t.0'), bolded);
  assert.strictEqual(await marked(),'The slow green turtle jumps over the **lazy dog**.');
  assert.ok((await exec('undo_last_edit', {}, 'u1'))._ok);
  deq(fake.fmt('t.0'), plain);
});

// Docs stores the font the text shows with a bold write (real-docs.js fact 7b): the formatting view leaves out a font equal
// to Normal text's where unformatted text is the most common (docs-model.js spanDefault), reading the named styles once
// per turn when a run sets a font (style-sheet.js knowUnmarkedFont).
test('the formatting view: a bold word\'s stored font equal to Normal text\'s is left out; the named styles are read only when needed', async () => {
  const read = async (id) => (await T.executeTool({ id, function: { name: 'read_document', arguments: '{"scope":{"start":1,"end":2},"include":["formatting"],"doc":null}' } }, 'edit', as)).content;
  const namedGets = () => fake.log.filter((x) => x.method === 'GET' && /namedStyles/.test(decodeURIComponent(x.url))).length;
  await fresh(docSpec({ items: [{ p: 'Methods', style: 'HEADING_2', fmt: [[0, 7, { bold: true, font: 'Arial' }]] }, { p: 'Plain body text.' }] }));
  const r = await read('v1');
  assert.ok(r.includes('Unmarked text: Arial 11.') && r.endsWith('\n1: [h2] **Methods**\n2: Plain body text.'), r);
  assert.strictEqual(namedGets(), 1);
  await read('v2'); // the same turn: no second read
  assert.strictEqual(namedGets(), 1);
  // Normal text in Georgia: the stored Arial is shown
  await fresh({ ...docSpec({ items: [{ p: 'Methods', style: 'HEADING_2', fmt: [[0, 7, { bold: true, font: 'Arial' }]] }, { p: 'Plain body text.' }] }), namedStyles: { NORMAL_TEXT: { font: 'Georgia' } } });
  assert.ok((await read('v3')).endsWith('\n1: [h2] {**Methods**}(font=Arial)\n2: Plain body text.'));
  // no run sets a font, or most text sets its own: nothing is read
  await fresh(docSpec({ items: [{ p: 'Methods', style: 'HEADING_2', fmt: [[0, 7, { bold: true }]] }, { p: 'Plain body text.' }] }));
  await read('v4');
  await fresh(docSpec({ items: [{ p: 'Methods', style: 'HEADING_2', fmt: [[0, 7, { bold: true, font: 'Arial' }]] }, { p: 'Plain body text.', fmt: [[0, 16, { font: 'Georgia' }]] }] }));
  assert.ok((await read('v5')).endsWith('\n1: [h2] {**Methods**}(font=Arial)\n2: Plain body text.'));
  assert.strictEqual(namedGets(), 0);
  // the spans' default: model.textDefault, with Normal text's font when unformatted text is the most common
  deq(T.spanDefault({ textDefault: { font: 'Georgia', size: null, color: null } }), { font: 'Georgia', size: null, color: null });
  deq(T.spanDefault({ docId: 'NEVER-READ', textDefault: { font: null, size: null, color: null } }), { font: null, size: null, color: null });
});

test('format_text: the undo of a bold write resets the font Docs stored with it; a "No change" reply leaves that font out', async () => {
  await fresh(docSpec({ items: [{ p: LINE }] }));
  const plain = fake.fmt('t.0');
  const w = pushTool(await fmtCall('lazy dog', { bold: true }, 'b1'));
  assert.strictEqual(w._edit.requests[0].updateTextStyle.fields, 'bold,weightedFontFamily');
  // the same call again: nothing to write; the reply shows the line without the stored font (the named styles read first)
  const again = await fmtCall('lazy dog', { bold: true }, 'b2');
  assert.strictEqual(again.content, 'Already done in this message: line 1 now reads: The slow green turtle jumps over the **lazy dog**.\nDo not call format_text again for this.');
  assert.ok((await exec('undo_last_edit', {}, 'b1u'))._ok);
  deq(fake.fmt('t.0'), plain);
});

test('format_text: a font over partly bold text re-applies bold per bold stretch; bold given explicitly wins', async () => {
  // bold as the API leaves it (with the font the text shows), so the undo can restore it exactly
  await fresh(docSpec({ items: [{ p: LINE, fmt: [[37, 41, { bold: true, font: 'Arial' }], [42, 45, { bold: true, weight: 700, font: 'Roboto' }]] }] }));
  const s = as.model.lines[0].start;
  const before = fake.fmt('t.0');
  const w = pushTool(await fmtCall('over the lazy dog', { font: 'Georgia' }, 'g1'));
  assert.ok(w._ok, w.content);
  const reqs = lastPost().requests.map((r) => r.updateTextStyle);
  assert.strictEqual(reqs[0].fields, 'weightedFontFamily');
  deq(reqs.slice(1), [
    { range: rng(s + 37, s + 41), textStyle: { bold: true }, fields: 'bold' },
    { range: rng(s + 42, s + 45), textStyle: { bold: true }, fields: 'bold' },
  ]);
  assert.strictEqual(await marked(),'The slow green turtle jumps {over the **lazy** **dog**}(font=Georgia).');
  assert.ok((await exec('undo_last_edit', {}, 'g2'))._ok);
  deq(fake.fmt('t.0'), before);
  // bold: false with a font: no extra request, bold off
  assert.ok((await fmtCall('lazy', { font: 'Georgia', bold: false }, 'g3'))._ok);
  assert.strictEqual(lastPost().requests.length, 1);
  assert.strictEqual(lastPost().requests[0].updateTextStyle.fields, 'bold,weightedFontFamily');
  assert.ok(!as.model.lines[0].runs.some((r) => r.bold && r.s === 37));
});
