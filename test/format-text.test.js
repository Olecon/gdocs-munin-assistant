'use strict';
// format_text with the text-level properties (font, size, color, highlight, link besides bold, italic,
// underline): the exact updateTextStyle and field mask of each argument, resets, link handling (Docs
// restyles links itself), the kept font weight, forgiving values, the no-op and repeat-guard results,
// the validation errors, undo of every property (heading links kept) and keepsLines.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installIdentity } = require('./lib/sandbox');
const { docSpec, docsBench, LINK_HEX } = require('./lib/fake-docs');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let T, state, fresh, exec, pushTool, lastPost;

before(async () => {
  const env = await load();
  T = env.T;
  state = env.state;
  ({ fresh, exec, pushTool, lastPost } = docsBench(env, installIdentity(env), ref));
  state.settings.provider = 'anthropic'; state.googleConnected = true;
});

const SPEC = () => docSpec({ items: [
  { p: 'Title', style: 'TITLE' },
  { p: 'The quick brown fox jumps over the lazy dog.', fmt: [[10, 15, { italic: true }]] },
  { p: 'Styled words here', fmt: [[0, 6, { font: 'Roboto', weight: 700, size: 14 }], [7, 12, { color: '#00B050', bg: '#FFFF00' }]] },
  { p: 'See the methods section', fmt: [[8, 15, { link: { headingId: 'h.abc' } }]] },
  { p: 'Visit site now', fmt: [[6, 10, { link: 'https://x.org', underline: true, color: LINK_HEX }]] },
] });
const NONE = { bold: null, italic: null, underline: null, font: null, size: null, color: null, highlight: null, link: null };
const fmtCall = (old_text, props, id, same) => exec('format_text', { old_text, ...NONE, ...props }, id, same);
const style = () => lastPost().requests[0].updateTextStyle;
const posts = () => fake.log.filter((x) => x.method === 'POST').length;
const at = (line, off) => as.model.lines[line - 1].start + off;
const rng = (s, e) => ({ startIndex: s, endIndex: e, tabId: 't.0' });

test('format_text: the request and field mask of every property', async () => {
  await fresh(SPEC());
  const cases = [
    ['quick', { bold: true }, { bold: true }, 'bold', 'bold on'],
    ['brown', { italic: false }, { italic: false }, 'italic', 'italic off'],
    ['fox', { underline: true }, { underline: true }, 'underline', 'underline on'],
    ['jumps', { font: ' times  new roman ' }, { weightedFontFamily: { fontFamily: 'Times New Roman', weight: 400 } }, 'weightedFontFamily', 'font Times New Roman'],
    ['over', { size: 14 }, { fontSize: { magnitude: 14, unit: 'PT' } }, 'fontSize', 'size 14'],
    ['the lazy', { color: 'red' }, { foregroundColor: { color: { rgbColor: { red: 1 } } } }, 'foregroundColor', 'color #FF0000'],
    ['dog', { highlight: '#FFFF00' }, { backgroundColor: { color: { rgbColor: { red: 1, green: 1 } } } }, 'backgroundColor', 'highlight #FFFF00'],
    ['The', { link: 'https://example.com/' }, { link: { url: 'https://example.com/' } }, 'link', 'link https://example.com/'],
  ];
  for (const [text, props, textStyle, fields, how] of cases) {
    const off = as.model.lines[1].text.indexOf(text);
    const w = await fmtCall(text, props);
    assert.ok(w._ok, w.content);
    deq(style(), { range: rng(at(2, off), at(2, off + text.length)), textStyle, fields });
    assert.ok(w.content.startsWith(`Done: formatted line 2 (${how}).\n${T.formatNote(as.model)}\nLines 2-2 now:\n2: `), w.content);
  }
  deq(fake.fmt('t.0')[1], [
    [0, 3, { link: 'https://example.com/', underline: true, color: LINK_HEX }], [4, 9, { bold: true }], [16, 19, { underline: true }],
    [20, 25, { font: 'Times New Roman' }], [26, 30, { size: 14 }], [31, 39, { color: '#FF0000' }], [40, 43, { bg: '#FFFF00' }],
  ]);
  assert.strictEqual(as.model.lines[1].runs.length, 7);
  // all properties at once: one request, fields in a fixed order; the result names every change
  await fresh(SPEC());
  const w = await fmtCall('lazy dog', { bold: true, italic: true, underline: false, font: 'Arial', size: 9.3, color: '#C00000', highlight: 'light yellow', link: 'mailto:a@b.org' });
  assert.ok(w._ok, w.content);
  deq(style().textStyle, { bold: true, italic: true, underline: false, weightedFontFamily: { fontFamily: 'Arial', weight: 400 }, fontSize: { magnitude: 9.5, unit: 'PT' },
    foregroundColor: { color: { rgbColor: { red: 192 / 255 } } }, backgroundColor: { color: { rgbColor: { red: 1, green: 242 / 255, blue: 204 / 255 } } }, link: { url: 'mailto:a@b.org' } });
  assert.strictEqual(style().fields, 'bold,italic,underline,weightedFontFamily,fontSize,foregroundColor,backgroundColor,link');
  assert.ok(w.content.startsWith('Done: formatted line 2 (bold on, italic on, underline off, font Arial, size 9.5, color #C00000, highlight #FFF2CC, link mailto:a@b.org).\n'), w.content);
});

test('format_text: resets leave the key out of textStyle; the font keeps its weight; undo restores every key', async () => {
  await fresh(SPEC());
  const orig = JSON.stringify(fake.fmt('t.0'));
  // font: the prior weight 700 is kept
  let w = pushTool(await fmtCall('Styled', { font: 'georgia' }, 'r1'));
  assert.ok(w._ok, w.content);
  deq(style(), { range: rng(at(3, 0), at(3, 6)), textStyle: { weightedFontFamily: { fontFamily: 'Georgia', weight: 700 } }, fields: 'weightedFontFamily' });
  deq(w._edit.requests, [{ updateTextStyle: { range: rng(at(3, 0), at(3, 6)), textStyle: { weightedFontFamily: { fontFamily: 'Roboto', weight: 700 } }, fields: 'weightedFontFamily' } }]);
  // resets: font "default", size 0, color "none", highlight "none"
  w = pushTool(await fmtCall('Styled words', { font: 'default', size: 0, color: 'none', highlight: 'none' }, 'r2'));
  assert.ok(w._ok, w.content);
  deq(style(), { range: rng(at(3, 0), at(3, 12)), textStyle: {}, fields: 'weightedFontFamily,fontSize,foregroundColor,backgroundColor' });
  assert.ok(w.content.startsWith('Done: formatted line 3 (font default, size default, color default, highlight removed).\n'), w.content);
  deq(fake.fmt('t.0')[2], []);
  // the inverse: one request per stretch of equal prior values, all touched keys listed
  const F = 'weightedFontFamily,fontSize,foregroundColor,backgroundColor';
  deq(w._edit.requests, [
    { updateTextStyle: { range: rng(at(3, 0), at(3, 6)), textStyle: { weightedFontFamily: { fontFamily: 'Georgia', weight: 700 }, fontSize: { magnitude: 14, unit: 'PT' } }, fields: F } },
    { updateTextStyle: { range: rng(at(3, 6), at(3, 7)), textStyle: {}, fields: F } },
    { updateTextStyle: { range: rng(at(3, 7), at(3, 12)), textStyle: { foregroundColor: { color: { rgbColor: { green: 176 / 255, blue: 80 / 255 } } }, backgroundColor: { color: { rgbColor: { red: 1, green: 1 } } } }, fields: F } },
  ]);
  assert.ok((await exec('undo_last_edit', {}, 'u2'))._ok);
  assert.ok((await exec('undo_last_edit', {}, 'u1'))._ok);
  deq(fake.fmt('t.0'), JSON.parse(orig));
});

test('format_text: links: set (Docs restyles it), remove (link, underline and color reset), heading links survive an undo', async () => {
  await fresh(SPEC());
  const orig = JSON.stringify(fake.fmt('t.0'));
  // set on plain text: only "link" is sent; the undo also resets the underline and color Docs added
  let w = pushTool(await fmtCall('quick', { link: ' https://example.com/q ' }, 'l1'));
  assert.ok(w._ok, w.content);
  deq(style(), { range: rng(at(2, 4), at(2, 9)), textStyle: { link: { url: 'https://example.com/q' } }, fields: 'link' });
  deq(fake.fmt('t.0')[1], [[4, 9, { link: 'https://example.com/q', underline: true, color: LINK_HEX }], [10, 15, { italic: true }]]);
  assert.ok(w.content.includes('\n2: The [quick](https://example.com/q) *brown*'), w.content);
  deq(w._edit.requests, [{ updateTextStyle: { range: rng(at(2, 4), at(2, 9)), textStyle: {}, fields: 'link,underline,foregroundColor' } }]);
  assert.ok((await exec('undo_last_edit', {}, 'l1u'))._ok);
  deq(fake.fmt('t.0'), JSON.parse(orig));
  // remove: "" and "none" both reset link, underline and color; undo brings all three back
  for (const off of ['', 'none']) {
    w = pushTool(await fmtCall('site', { link: off }, 'l2'));
    assert.ok(w._ok, w.content);
    deq(style(), { range: rng(at(5, 6), at(5, 10)), textStyle: {}, fields: 'link,underline,foregroundColor' });
    assert.ok(w.content.startsWith('Done: formatted line 5 (link removed).\n') && w.content.includes('\n5: Visit site now\n'), w.content);
    deq(fake.fmt('t.0')[4], []);
    deq(w._edit.requests, [{ updateTextStyle: { range: rng(at(5, 6), at(5, 10)),
      textStyle: { link: { url: 'https://x.org' }, underline: true, foregroundColor: { color: { rgbColor: { red: 17 / 255, green: 85 / 255, blue: 204 / 255 } } } }, fields: 'link,underline,foregroundColor' } }]);
    assert.ok((await exec('undo_last_edit', {}, 'l2u'))._ok);
    deq(fake.fmt('t.0'), JSON.parse(orig));
  }
  // removing a link together with an explicit underline: the given value wins, no field twice
  w = pushTool(await fmtCall('site', { link: 'none', underline: true }, 'l3'));
  deq(style(), { range: rng(at(5, 6), at(5, 10)), textStyle: { underline: true }, fields: 'underline,link,foregroundColor' });
  assert.ok((await exec('undo_last_edit', {}, 'l3u'))._ok);
  // a heading link replaced by a URL, then undone: the raw heading link comes back
  w = pushTool(await fmtCall('methods', { link: 'https://y.org' }, 'l4'));
  assert.ok(w._ok, w.content);
  deq(w._edit.requests, [{ updateTextStyle: { range: rng(at(4, 8), at(4, 15)), textStyle: { link: { headingId: 'h.abc' } }, fields: 'link,underline,foregroundColor' } }]);
  assert.ok((await exec('undo_last_edit', {}, 'l4u'))._ok);
  deq(fake.fmt('t.0')[3], [[8, 15, { link: { headingId: 'h.abc' } }]]);
  deq(fake.fmt('t.0'), JSON.parse(orig));
  // other properties over a heading link leave it alone, and so does their undo
  w = pushTool(await fmtCall('the methods section', { bold: true }, 'l5'));
  deq(style().fields, 'bold');
  assert.ok((await exec('undo_last_edit', {}, 'l5u'))._ok);
  deq(fake.fmt('t.0'), JSON.parse(orig));
});

test('format_text: forgiving values: "true"/yes/1 flags, "14pt", #RGB, rgb(), color names, a missing key is null', async () => {
  await fresh(SPEC());
  const sent = async (props, text = 'lazy dog') => { const w = await fmtCall(text, props); assert.ok(w._ok, w.content); return [style().textStyle, style().fields]; };
  deq(await sent({ bold: 'true', italic: 'yes', underline: 1 }), [{ bold: true, italic: true, underline: true }, 'bold,italic,underline']);
  deq(await sent({ bold: 'no', italic: 0, underline: ' FALSE ' }), [{ bold: false, italic: false, underline: false }, 'bold,italic,underline']);
  deq(await sent({ size: '14pt' }), [{ fontSize: { magnitude: 14, unit: 'PT' } }, 'fontSize']);
  deq(await sent({ size: '12 pt', color: '#0f0' }), [{ fontSize: { magnitude: 12, unit: 'PT' }, foregroundColor: { color: { rgbColor: { green: 1 } } } }, 'fontSize,foregroundColor']);
  deq(await sent({ color: 'Dark Red' }), [{ foregroundColor: { color: { rgbColor: { red: 192 / 255 } } } }, 'foregroundColor']);
  deq(await sent({ highlight: 'rgb(0, 0, 255)' }), [{ backgroundColor: { color: { rgbColor: { blue: 1 } } } }, 'backgroundColor']);
  deq(await sent({ color: 'black' }), [{ foregroundColor: { color: { rgbColor: {} } } }, 'foregroundColor']);
  // a missing key and the string "null" leave the property; "" too (except for link)
  let w = await exec('format_text', { old_text: 'quick', italic: true });
  assert.ok(w._ok, w.content);
  deq([style().textStyle, style().fields], [{ italic: true }, 'italic']);
  w = await exec('format_text', { old_text: 'brown', bold: true, font: '', size: 'null', color: '' });
  deq([style().textStyle, style().fields], [{ bold: true }, 'bold']);
  // markers around old_text are still stripped
  w = await fmtCall('**fox**', { size: 20 });
  assert.ok(w._ok && w.content.endsWith('\nNote: formatting markers/quotes were removed from old_text to find it; pass the plain document text next time.'), w.content);
  // an unknown font is sent, with a note
  w = await fmtCall('jumps', { font: 'Fooo Sans' });
  assert.ok(w._ok, w.content);
  deq(style().textStyle, { weightedFontFamily: { fontFamily: 'Fooo Sans', weight: 400 } });
  assert.ok(w.content.endsWith('\nNote: "Fooo Sans" is not a common Docs font; Google Docs shows unknown fonts as Arial.'), w.content);
  assert.strictEqual(T.toolCallSummary('format_text', { old_text: 'jumps', ...NONE, font: 'Fooo Sans', size: 14, color: '#FF0000', bold: 'yes' }), '"jumps" (bold on, font Fooo Sans, size 14, color #FF0000)');
});

test('format_text: validation errors, verbatim; nothing is sent', async () => {
  await fresh(SPEC());
  const EX = '{"old_text":"lazy dog","bold":true,"italic":null,"underline":null,"font":null,"size":null,"color":null,"highlight":null,"link":null}';
  const err = async (args, content, short) => {
    const w = await exec('format_text', args);
    assert.strictEqual(w.content, 'Error: ' + content);
    assert.strictEqual(w._ok, false);
    if (short) assert.strictEqual(w._message, short);
  };
  await err({ bold: true }, `invalid arguments. Example: ${EX}`, 'Invalid tool arguments');
  await err({ old_text: 'lazy dog', ...NONE }, `pass at least one property that is not null (bold, italic, underline, font, size, color, highlight, link). Example: ${EX}`, 'format_text: no formatting given');
  const COLOR = 'is not a color: use "#RRGGBB" (e.g. "#C00000") or one of red, orange, yellow, green, blue, purple, gray, black, white; "none" resets';
  await err({ old_text: 'lazy dog', ...NONE, color: 'reddish' }, `color "reddish" ${COLOR}`, 'format_text: invalid color');
  await err({ old_text: 'lazy dog', ...NONE, highlight: '#12345' }, `highlight "#12345" ${COLOR}`, 'format_text: invalid highlight');
  await err({ old_text: 'lazy dog', ...NONE, color: 7 }, `color 7 ${COLOR}`);
  const SIZE = 'size must be a number of points from 1 to 400 (e.g. 11, 14); 0 resets to the default';
  for (const size of [500, 'big', -3, 0.2]) await err({ old_text: 'lazy dog', ...NONE, size }, SIZE, 'format_text: invalid size');
  const FONT = 'font must be a font family name such as "Arial" or "Times New Roman"; "default" resets';
  for (const font of [5, true, 'Ari{al}', 'x'.repeat(101)]) await err({ old_text: 'lazy dog', ...NONE, font }, FONT, 'format_text: invalid font');
  for (const link of ['javascript:alert(1)', 'www.x.org', '/relative', 'https://', 42]) {
    await err({ old_text: 'lazy dog', ...NONE, link }, `link must be a full URL starting with https://, http:// or mailto: (got ${JSON.stringify(link)}); "none" removes the link`, 'format_text: invalid link');
  }
  await err({ old_text: 'lazy dog', ...NONE, bold: 'maybe' }, 'bold must be true, false or null (JSON booleans); got the string "maybe"', 'format_text: invalid bold');
  assert.strictEqual(posts(), 0);
});

test('format_text: no change, and the repeat guard within a turn', async () => {
  await fresh(SPEC());
  // the text already has the values: nothing sent, no journal entry, _ok
  let w = await fmtCall('Styled', { size: '14', font: 'roboto' });
  assert.strictEqual(w.content, 'No change: «Styled» on line 3 is already in Roboto, size 14.\nLines 3-3 now:\n3: {Styled}(font=Roboto size=14) {words}(color=#00B050 bg=#FFFF00) here');
  assert.ok(w._ok && !w._edit && w._message === 'No change (line 3)', JSON.stringify(w));
  w = await fmtCall('lazy dog', { bold: false, link: 'none', color: 'none' });
  assert.ok(w._ok && w.content.startsWith('No change: «lazy dog» on line 2 is already not bold, in the default color, not a link.\nLines 2-2 now:\n2: The quick'), w.content);
  assert.strictEqual(posts(), 0);
  // a success, then the same call again in the same turn (also with loosely written values): "Already done"
  w = pushTool(await fmtCall('lazy dog', { bold: true, size: 14 }, 'g1'));
  assert.ok(w._ok && w._edit, w.content);
  const REPEAT = 'Already done in this message: line 2 now reads: The quick *brown* fox jumps over the {**lazy dog**}(size=14).\nDo not call format_text again for this.';
  for (const props of [{ bold: true, size: 14 }, { bold: 'true', size: '14pt' }]) {
    w = await fmtCall('lazy dog', props, 'g2', true);
    assert.strictEqual(w.content, REPEAT);
    assert.ok(w._ok && !w._edit && w._message === 'Already done (line 2)');
  }
  assert.strictEqual(posts(), 1);
  // a different call that is a no-op is "No change", not "Already done"
  w = await fmtCall('lazy dog', { bold: true });
  assert.ok(w.content.startsWith('No change: «lazy dog» on line 2 is already bold.'), w.content);
  // after an undo the same call is applied again
  pushTool(await exec('undo_last_edit', {}, 'g1u'));
  w = pushTool(await fmtCall('lazy dog', { bold: true, size: 14 }, 'g3'));
  assert.ok(w._ok && w._edit && posts() === 3, w.content);
  // a new turn (fresh snapshot): no repeat memory, only "No change"
  const turn2 = T.takeSnapshot(); T.snapshotDocument(turn2);
  w = await T.executeTool({ id: 'g4', function: { name: 'format_text', arguments: JSON.stringify({ old_text: 'lazy dog', ...NONE, bold: true, size: 14 }) } }, 'edit', turn2);
  assert.ok(w.content.startsWith('No change: «lazy dog» on line 2 is already bold, size 14.\n'), w.content);
  // a multi-line repeat lists the lines
  w = pushTool(await fmtCall('lazy dog.\nStyled', { italic: true }, 'g5'));
  assert.ok(w._ok, w.content);
  w = await fmtCall('lazy dog.\nStyled', { italic: true });
  assert.ok(w.content.startsWith('Already done in this message: lines 2–3 now read:\nLines 2-3 now:\n2: ') && w.content.endsWith('\nDo not call format_text again for this.'), w.content);
});

test('format_text: keepsLines: a line-number edit may follow it in the same response', async () => {
  await fresh(SPEC());
  let w = pushTool(await fmtCall('Styled', { bold: true }, 'k1'));
  assert.ok(w._ok, w.content);
  assert.strictEqual(as.responseWrite, null);
  w = pushTool(await exec('insert_after_line', { line: 3, text: 'New line' }, 'k2', true));
  assert.ok(w._ok, w.content);
  assert.strictEqual(fake.text('t.0').split('\n')[3], 'New line');
  // ... but not after an insert
  w = await exec('insert_after_line', { line: 1, text: 'Another' }, 'k3', true);
  assert.ok(!w._ok && /line numbers changed/.test(w.content), w.content);
});
