'use strict';
// The page setup (updateDocumentStyle): the sheet's page entry (sizes, orientation, margins in cm / mm / in / pt, header and
// footer, first page number, first-page header, pageless; errors; layers merged field by field), document_styles read (the
// Page line, "(differs)" where it differs), action page (the exact request and mask, orientation by flipPageOrientation,
// "No change", verified by reading documentStyle again, the pageless refusal), apply with the sheet's page entry (named
// styles and page setup in one journal entry), undo by the exact inverse (blocked when the page setup changed since).
const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, installIdentity } = require('./lib/sandbox');
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
beforeEach(() => { T.namedStylesSession.unavailable = ''; });

const pt = (n) => ({ magnitude: n, unit: 'PT' });
// A new Docs document: Letter, 1 inch margins, header and footer 0.5 inch.
const LETTER = { pageSize: { width: pt(612), height: pt(792) }, marginTop: pt(72), marginBottom: pt(72), marginLeft: pt(72), marginRight: pt(72),
  marginHeader: pt(36), marginFooter: pt(36), pageNumberStart: 1, documentFormat: { documentMode: 'PAGES' } };
const doc = (ds = LETTER, over = {}) => {
  const s = { ...docSpec({ items: [{ p: 'Intro', style: 'HEADING_1' }, { p: 'Body.' }] }), ...over };
  s.tabs[0].documentStyle = JSON.parse(JSON.stringify(ds));
  return s;
};
const posts = () => fake.log.filter((x) => x.method === 'POST');
const page = (text, id) => exec('document_styles', { action: 'page', page: text }, id);
const ds = () => { const d = { ...fake.segments('t.0').documentStyle }; delete d.defaultHeaderId; delete d.defaultFooterId; return d; };
const cm = (n) => Math.round(n * (72 / 2.54) * 100) / 100;
const undo = async () => { const u = pushTool(await exec('undo_last_edit', {})); assert.ok(u._ok, u.content); return u; };

test('the page entry: sizes, orientation, margins in every unit, header and footer, first page number, first-page header, pageless', () => {
  const p = (t) => T.parsePageEntry(t);
  deq(p('A4 landscape, margins 2.5 cm, first page number 3, no header on first page').value, { useFirstPageHeaderFooter: true, pageNumberStart: 3,
    size: { name: 'A4', w: 595.28, h: 841.89 }, orientation: 'landscape', marginTop: cm(2.5), marginRight: cm(2.5), marginBottom: cm(2.5), marginLeft: cm(2.5) });
  deq(p('letter margins 1in/1.25in').value, { size: { name: 'Letter', w: 612, h: 792 }, marginTop: 72, marginRight: 90, marginBottom: 72, marginLeft: 90 });
  deq(p('margins 20/25/20/30 mm').value, { marginTop: cm(2), marginRight: cm(2.5), marginBottom: cm(2), marginLeft: cm(3) });
  deq(p('margins 2,5, left 3 cm header 12.7mm footer 36pt').value, { marginTop: cm(2.5), marginRight: cm(2.5), marginBottom: cm(2.5), marginLeft: cm(3), marginHeader: 36, marginFooter: 36 });
  deq(p('21 x 29.7 cm portrait').value, { size: { w: 595.28, h: 841.89 }, orientation: 'portrait' });
  deq(p('11x8.5in').value, { size: { w: 612, h: 792 } }); // portrait order; the orientation is a word of its own
  deq(p('pageless').value, { documentMode: 'PAGELESS' });
  deq(p('pages same first page').value, { useFirstPageHeaderFooter: false, documentMode: 'PAGES' });
  // errors name what is wrong and how to write it
  assert.match(p('A4 sideways').error, /^"page A4 sideways" is ignored: unknown word "sideways"; write e\.g\. page A4 landscape/);
  assert.match(p('margins 30 cm').error, /margins needs one, two or four lengths up to 20 cm \(got "30cm"\)/);
  assert.match(p('margins 1/2/3').error, /margins needs one, two or four lengths/);
  assert.match(p('first page number x').error, /the first page number must be a whole number \(got "x"\)/);
  assert.match(p('header').error, /header needs a length up to 10 cm/);
  assert.match(p('1x1 cm').error, /the page size "1x1cm" is out of range/);
  assert.match(p('').error, /it names no setting/);
  // the words of a value read back as the same value
  const v = p('A4 landscape margins 2/3 cm header 1 cm first page number 2 different first page pageless').value;
  deq(T.pageWords(v), 'A4 landscape margins 2/3 cm header 1 cm first page number 2 different first page pageless');
  deq(p(T.pageWords(v)).value, v);
});

test('the sheet: page entries merge field by field (MAIN.md, then DOC.md); an invalid one is ignored with its message; the default has none', () => {
  assert.strictEqual(T.resolveStyleSheet('', '').page, null);
  const s = T.resolveStyleSheet('Formatting: page landscape', 'Formatting: body Arial 11; page A4 margins 2 cm');
  deq(s.page, { size: { name: 'A4', w: 595.28, h: 841.89 }, marginTop: cm(2), marginRight: cm(2), marginBottom: cm(2), marginLeft: cm(2), orientation: 'landscape' });
  const bad = T.parseStyleSheet('Formatting: h1 16; page A4 sideways');
  deq(bad.ignored, ['page A4 sideways']);
  assert.match(bad.errors[0], /^"page A4 sideways" is ignored: unknown word "sideways"/);
  deq(T.resolveStyleSheet('Formatting: page A4 sideways', '').page, null);
});

test('read: the Page line in the sheet\'s words, "(differs)" when the sheet\'s page entry differs; the entry in the sheet in force', async () => {
  await fresh(doc());
  let r = await exec('document_styles', { action: 'read', page: null });
  assert.match(r.content, /\nPage: Letter portrait margins 2\.54 cm header 1\.27 cm footer 1\.27 cm first page number 1\nSheet in force: /);
  as.docInstructions = 'Formatting: page A4 landscape margins 2 cm';
  r = await exec('document_styles', { action: 'read', page: null });
  assert.match(r.content, /\nPage: Letter portrait margins 2\.54 cm header 1\.27 cm footer 1\.27 cm first page number 1 \(differs\)\n/);
  assert.match(r.content, /; page A4 landscape margins 2 cm \(from DOC\.md\)$/);
  deq(posts().length, 0);
});

test('action page: the exact updateDocumentStyle (portrait size + flip for landscape, margins in PT, the tab); verified; "No change"; exact undo', async () => {
  await fresh(doc());
  const before = ds();
  const r = pushTool(await page('A4 landscape, margins 2.5 cm, first page number 3, no header on first page', 'pg1'));
  assert.ok(r._ok, r.content);
  deq(r.content, 'Done: set the page setup (A4 landscape margins 2.5 cm first page number 3 different first page).');
  deq(posts().length, 1);
  const m = pt(cm(2.5));
  deq(posts()[0].body, { requests: [{ updateDocumentStyle: { documentStyle: { pageSize: { width: pt(595.28), height: pt(841.89) }, flipPageOrientation: true,
    marginTop: m, marginBottom: m, marginLeft: m, marginRight: m, pageNumberStart: 3, useFirstPageHeaderFooter: true },
  fields: 'pageSize,flipPageOrientation,marginTop,marginBottom,marginLeft,marginRight,pageNumberStart,useFirstPageHeaderFooter', tabId: 't.0' } }] });
  deq([r._edit.kind, r._message, r._cardLabel], ['named-styles', 'Set the page setup', 'Page']);
  // the panel's model follows the new revision: the next write is not refused
  const ins = pushTool(await exec('insert_after_line', { line: 2, text: 'More.', style: null }));
  assert.ok(ins._ok, ins.content);
  const again = await page('A4 landscape margins 25mm', 'pg2');
  deq([again.content, again._ok, again._edit], ['No change: the page setup is already A4 landscape margins 2.5 cm.', true, undefined]);
  await undo(); // the insert
  const u = await undo();
  assert.match(u.content, /^Done: restored the page setup/);
  deq(ds(), before);
  // the inverse: the former values; flipPageOrientation and useFirstPageHeaderFooter were not set, so they are reset
  deq(posts().pop().body.requests, [{ updateDocumentStyle: { documentStyle: { pageSize: { width: pt(612), height: pt(792) },
    marginTop: pt(72), marginBottom: pt(72), marginLeft: pt(72), marginRight: pt(72), pageNumberStart: 1 },
  fields: 'pageSize,flipPageOrientation,marginTop,marginBottom,marginLeft,marginRight,pageNumberStart,useFirstPageHeaderFooter', tabId: 't.0' } }]);
});

test('orientation alone flips the page; a landscape size given as width > height counts as landscape; a size alone keeps the orientation', async () => {
  await fresh(doc());
  pushTool(await page('landscape'));
  deq(posts().pop().body.requests[0].updateDocumentStyle, { documentStyle: { flipPageOrientation: true }, fields: 'flipPageOrientation', tabId: 't.0' });
  // an older landscape document: the size itself is wide, no flip
  await fresh(doc({ ...LETTER, pageSize: { width: pt(792), height: pt(612) } }));
  assert.match((await page('landscape')).content, /^No change: the page setup is already landscape\./);
  pushTool(await page('portrait'));
  deq(posts().pop().body.requests[0].updateDocumentStyle.documentStyle, { flipPageOrientation: true });
  // a size alone on a landscape page: portrait order, flipped
  await fresh(doc({ ...LETTER, flipPageOrientation: true }));
  pushTool(await page('A4'));
  deq(posts().pop().body.requests[0].updateDocumentStyle.documentStyle, { pageSize: { width: pt(595.28), height: pt(841.89) } });
  const read = await exec('document_styles', { action: 'read', page: null });
  assert.match(read.content, /\nPage: A4 landscape /);
});

test('page: errors (no text, a bad entry) send nothing; outside Auto it is refused like every write', async () => {
  await fresh(doc());
  const e1 = await page(null);
  deq([e1._ok, e1._message], [false, 'document_styles: no page given']);
  const e2 = await page('A4 sideways');
  assert.match(e2.content, /^Error: "A4 sideways" is ignored: unknown word "sideways"; write e\.g\. page A4 landscape/);
  const m = await T.executeTool({ id: 'm1', type: 'function', function: { name: 'document_styles', arguments: '{"action":"page","page":"A4"}' } }, 'manual', as);
  assert.match(m.content, /^Error: the document cannot be modified here/);
  deq(posts().length, 0);
});

test('pageless: a refused documentFormat is sent again without it, with a note; pageless alone is an error that says where to switch it', async () => {
  await fresh(doc(LETTER, { noPagelessUpdate: true }));
  const r = pushTool(await page('pageless margins 2 cm', 'pl1'));
  assert.ok(r._ok, r.content);
  assert.match(r.content, /^Done: set the page setup \(margins 2 cm pageless\)\.\nNote: Google Docs did not accept the pageless setting \(.*documentMode cannot be changed.*\); the user can switch it in File > Page setup\.$/);
  deq(posts().length, 2);
  deq(posts()[1].body.requests[0].updateDocumentStyle.fields, 'marginTop,marginBottom,marginLeft,marginRight');
  deq(ds().marginTop, pt(cm(2)));
  await undo();
  deq(ds().marginTop, pt(72));
  const only = await page('pageless', 'pl2');
  assert.ok(!only._ok);
  assert.match(only.content, /^Error: Google Docs did not accept the pageless setting \(.*\); the user can switch it in File > Page setup/);
  // a server that takes it: the mode is written with its own mask
  await fresh(doc());
  pushTool(await page('pageless'));
  deq(posts().pop().body.requests[0].updateDocumentStyle, { documentStyle: { documentFormat: { documentMode: 'PAGELESS' } }, fields: 'documentFormat', tabId: 't.0' });
  deq(ds().documentFormat, { documentMode: 'PAGELESS' });
  await undo();
  deq(ds().documentFormat, { documentMode: 'PAGES' });
});

test('verification: a value the re-read documentStyle lacks is named; undo is blocked once the page setup changed in Docs', async () => {
  await fresh(doc());
  const real = fake.fetch;
  fake.fetch = async (url, init) => {
    if (init && init.method === 'POST') {
      const body = JSON.parse(init.body);
      for (const r of body.requests) if (r.updateDocumentStyle) { delete r.updateDocumentStyle.documentStyle.pageNumberStart; }
      init = { ...init, body: JSON.stringify(body) };
    }
    return real(url, init);
  };
  const r = pushTool(await page('first page number 5 margins 2 cm'));
  assert.ok(r._ok, r.content);
  assert.match(r.content, /\nNote: Google Docs did not apply all of the page setup; the first page number still differs\. Check with document_styles read\.$/);
  fake.fetch = real;
  fake.tabs[0].docStyle.marginLeft = pt(100); // the user changed it in Docs
  const blocked = pushTool(await exec('undo_last_edit', {}));
  assert.ok(!blocked._ok);
  assert.match(blocked.content, /the page setup changed after that edit, so it cannot be undone automatically/);
});

test('apply: the sheet\'s page entry goes with the named styles (two batches, one journal entry, one undo); page only when the named styles are not available', async () => {
  await fresh(doc());
  as.docInstructions = 'Formatting: page A4 margins 2 cm';
  const before = ds();
  const namedBefore = fake.named('t.0');
  const r = pushTool(await exec('document_styles', { action: 'apply', page: null }, 'ap1'));
  assert.ok(r._ok, r.content);
  assert.match(r.content, /^Done: set the document's styles to the formatting sheet \(Normal text: Times New Roman 12 justify space 0\/0; .*; Page: A4 margins 2 cm\)\.$/);
  deq(posts().map((p) => Object.keys(p.body.requests[0])[0]), ['updateNamedStyle', 'updateDocumentStyle']);
  deq(ds().pageSize, { width: pt(595.28), height: pt(841.89) });
  const u = await undo();
  assert.match(u.content, /^Done: restored the document's named styles \(Normal text, .*\) and the page setup/);
  deq(posts().pop().body.requests.map((q) => Object.keys(q)[0]).slice(-2), ['updateNamedStyle', 'updateDocumentStyle']);
  deq([ds(), fake.named('t.0')], [before, namedBefore]);
  // the named styles refused in this session: apply sets the page setup alone, with the note
  await fresh(doc(LETTER, { noNamedStyleUpdate: true }));
  as.docInstructions = 'Formatting: page A4';
  const refused = await exec('document_styles', { action: 'apply', page: null });
  assert.match(refused.content, /^Not available: /);
  const p = pushTool(await exec('document_styles', { action: 'apply', page: null }, 'ap2'));
  assert.ok(p._ok, p.content);
  assert.match(p.content, /^Done: set the document's page setup to the formatting sheet \(Page: A4\)\.\nNote: Not available: /);
  deq(posts().pop().body.requests.map((q) => Object.keys(q)[0]), ['updateDocumentStyle']);
  const nc = await exec('document_styles', { action: 'apply', page: null });
  assert.match(nc.content, /^No change: the page setup already follows the formatting sheet\./);
});
