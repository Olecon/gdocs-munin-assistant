'use strict';
// The compact results of the writing tools: what was done, where the lines are now and the new line count, without
// the text (the card keeps it in the "_" fields); the text comes back only where the document, read again, differs
// from what was sent, and then only the differing part. Formatting comes back only when it did not take; the paste
// keeps its one-paste-per-message wording.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { load, installIdentity } = require('./lib/sandbox');
const { docSpec, docsBench } = require('./lib/fake-docs');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let T, state, fresh, exec;

before(async () => {
  const env = await load();
  T = env.T;
  state = env.state;
  ({ fresh, exec } = docsBench(env, installIdentity(env), ref));
  state.settings.provider = 'anthropic'; state.googleConnected = true;
});

// After every batchUpdate, change paragraph i of the first body run the way Docs might normalize what it got.
function normalizeAfterWrites(i, fn) {
  const orig = fake.fetch;
  fake.fetch = async (url, init = {}) => {
    const r = await orig(url, init);
    if ((init.method || 'GET') === 'POST') {
      const p = fake.tabs[0].blocks[0].paras[i];
      p.text = fn(p.text);
    }
    return r;
  };
  return () => { fake.fetch = orig; };
}

// Lines of docSpec(): 1 Report, 2 Intro, 3 Methods, 4 Alpha beta gamma., 5 Alpha beta delta., 6-7 a table, 8 Details, 9 Image, 10 Last line.
test('every write tool: one line without the text; the line numbers and the new line count stay', async () => {
  await fresh();
  const cases = [
    ['replace_text', { old_text: 'beta gamma', new_text: 'beta GAMMA' }, 'Done: replaced line 4; the document has 10 lines.'],
    ['replace_text', { old_text: 'GAMMA.', new_text: 'GAMMA.\nA new line here.' }, 'Done: replaced line 4; now lines 4–5; the document has 11 lines.'],
    ['insert_after_line', { line: 3, text: 'Yushin I. I., Golyshev V. M., Baranovskaya E. E.' }, 'Done: inserted after line 3; now line 4; the document has 12 lines.'],
    ['delete_lines', { start: 4, end: 5 }, 'Done: deleted lines 4–5; the document has 10 lines.'],
    ['replace_all', { old_text: 'Alpha beta', new_text: 'Omega' }, 'Done: replaced 1 occurrence on line 5; the document has 10 lines.'],
    ['format_text', { old_text: 'Omega', bold: true, italic: null, underline: null, font: null, size: null, color: null, highlight: null, link: null },
      'Done: formatted line 5 (bold on); the document has 10 lines.'],
    ['format_lines', { start: 2, end: 2, style: 'h2', align: null, list: null, indent_start: null, indent_first_line: null, space_above: null, space_below: null, line_spacing: null },
      'Done: formatted line 2 (h2); the document has 10 lines.'],
  ]; // replace_section always asks first: its result is in write-guards.test.js
  for (const [name, args, want] of cases) {
    const w = await exec(name, args);
    assert.strictEqual(w.content, want, `${name}: ${w.content}`);
  }
  // the text stays for the card
  const w = await exec('insert_after_line', { line: 1, text: 'Card only.' });
  assert.ok(!w.content.includes('Card only.') && w._cardText === 'Card only.' && w._cardLabel === 'Inserted text', w.content);
});

test('the text differs after the write (Docs normalized it): only the differing part, marked as such', async () => {
  await fresh();
  const restore = normalizeAfterWrites(3, (t) => t.replace('"x"', '“x”'));
  const w = await exec('replace_text', { old_text: 'beta gamma', new_text: 'beta "x" gamma' });
  restore();
  assert.ok(w._ok, w.content);
  assert.strictEqual(w.content, 'Done: replaced line 4; the document has 10 lines.\nNote: Google Docs stored the text differently on line 4: it reads «“x”» where you sent «"x"».');
  // insert_after_line, and the same for replace_all (its own expectation)
  await fresh();
  const undo = normalizeAfterWrites(4, (t) => t.replace('...', '…'));
  const i = await exec('insert_after_line', { line: 4, text: 'one... two' });
  undo();
  assert.ok(/^Done: inserted after line 4; now line 5; the document has 11 lines\.\nNote: Google Docs stored the text differently on line 5: it reads «…» where you sent «\.\.\.»\.$/.test(i.content), i.content);
  await fresh();
  const undo2 = normalizeAfterWrites(4, (t) => t.replace('delta', 'Delta'));
  const a = await exec('replace_all', { old_text: 'beta', new_text: 'BETA' });
  undo2();
  assert.ok(a.content.startsWith('Done: replaced 2 occurrences on lines 4, 5; the document has 10 lines.\nNote: Google Docs stored the text differently on line 5: it reads «Delta» where you sent «delta».'), a.content);
});

test('formatting that did not take: the lines in the notation come back', async () => {
  await fresh();
  const orig = fake.fetch;
  fake.fetch = async (url, init = {}) => { // the bold is dropped on the way
    if ((init.method || 'GET') === 'POST') {
      const body = JSON.parse(init.body);
      body.requests = body.requests.map((rq) => (rq.updateTextStyle ? { updateTextStyle: { ...rq.updateTextStyle, textStyle: {}, fields: 'italic' } } : rq));
      init = { ...init, body: JSON.stringify(body) };
    }
    return orig(url, init);
  };
  const w = await exec('format_text', { old_text: 'beta gamma', bold: true, italic: null, underline: null, font: null, size: null, color: null, highlight: null, link: null });
  fake.fetch = orig;
  assert.ok(w._ok, w.content);
  assert.ok(w.content.startsWith('Done: formatted line 4 (bold on); the document has 10 lines.\nNote: Google Docs did not apply all of it (not shown: bold on); line 4 now reads:\n'), w.content);
  assert.ok(w.content.endsWith('\n4: Alpha beta gamma.'), w.content);
});

// A server that stores no explicit value for the textStyle fields keys (the field stays in the mask: a reset), as Docs
// may do with a value the text inherits anyway.
function dropTextFields(keys) {
  const orig = fake.fetch;
  fake.fetch = async (url, init = {}) => {
    if ((init.method || 'GET') === 'POST' && /:batchUpdate/.test(url)) {
      const body = JSON.parse(init.body);
      for (const rq of body.requests) if (rq.updateTextStyle) for (const k of keys) delete rq.updateTextStyle.textStyle[k];
      init = { ...init, body: JSON.stringify(body) };
    }
    return orig(url, init);
  };
  return () => { fake.fetch = orig; };
}
const FT = { op: 'format_text', line: null, all: null, bold: null, italic: null, underline: null, font: null, size: null, color: null, highlight: null, link: null };
const FL = { op: 'format_lines', end: null, style: null, align: null, list: null, indent_start: null, indent_first_line: null, space_above: null, space_below: null, line_spacing: null, indent_end: null, box: null, page_break_before: null };
const inheritSpec = () => docSpec({ items: [{ p: 'Body text here.' }, { p: 'Grey head', style: 'HEADING_3' }, { p: 'Blue head', style: 'HEADING_2' }] });

test('formatting that did not take: the note names what the re-read lacks; an edit_document report has the legend once', async () => {
  await fresh(inheritSpec());
  const undrop = dropTextFields(['bold']);
  const w = await exec('edit_document', { operations: [{ ...FT, old_text: 'Body', bold: true }, { ...FT, old_text: 'Grey', bold: true, italic: true }] });
  undrop();
  assert.ok(w._ok, w.content);
  const notes = w.content.split('\n').filter((l) => l.startsWith('Note: Google Docs did not apply'));
  assert.deepStrictEqual(notes, ['Note: Google Docs did not apply all of it (not shown: bold on); line 1 now reads:',
    'Note: Google Docs did not apply all of it (not shown: bold on); line 2 now reads:']);
  assert.strictEqual(w.content.split('\n').filter((l) => l.startsWith('Markers are notation')).length, 1, w.content);
});

test('formatting verification: a value the text inherits counts as applied when known (black body text, the named styles of a format_lines call); an unknown one does not', async () => {
  await fresh(inheritSpec());
  // black: Docs' default colour of body text and of h1/h2; h3 is grey by default, so black there is not assumed
  let undrop = dropTextFields(['foregroundColor']);
  let w = await exec('format_text', { ...FT, op: undefined, old_text: 'Body text', color: 'black' });
  assert.ok(w._ok && !/did not apply/.test(w.content), w.content);
  w = await exec('format_text', { ...FT, op: undefined, old_text: 'Grey head', color: 'black' });
  assert.ok(/did not apply all of it \(not shown: color #000000\); line 2 now reads:/.test(w.content), w.content);
  undrop();
  // with a format_lines in the call the named styles are read: Normal text is Arial, Heading 2 is 16 pt
  undrop = dropTextFields(['weightedFontFamily', 'fontSize']);
  w = await exec('edit_document', { operations: [{ ...FL, start: 1, align: 'center' }, { ...FT, old_text: 'Body text', font: 'Arial' }, { ...FT, old_text: 'Blue head', size: 16 }] });
  assert.ok(w._ok && !/did not apply/.test(w.content), w.content);
  w = await exec('edit_document', { operations: [{ ...FL, start: 1, align: 'right' }, { ...FT, old_text: 'Body text', font: 'Georgia' }] });
  assert.ok(/did not apply all of it \(not shown: font Georgia\); line 1 now reads:/.test(w.content), w.content);
  // without a format_lines a miss reads the named styles too (once per turn): the heading's own size is known, applied
  w = await exec('format_text', { ...FT, op: undefined, old_text: 'Blue head', size: 16 });
  assert.ok(w._ok && !/did not apply/.test(w.content), w.content);
  undrop();
});

test('a page part: the text comes back only when it reads differently', async () => {
  await fresh(docSpec({ items: [{ p: 'Body' }] }));
  const ok = await exec('page_parts', { action: 'set_text', part: 'header', number: null, text: 'Draft', after_text: null });
  assert.strictEqual(ok.content, 'Done: created the header with the text; the document has 1 lines.');
});

test('the paste: plain text, the one-paste-per-message wording, no JSON', () => {
  assert.ok(T.PASTE_DONE_NOTE.startsWith('Done: the text was pasted into the document.'));
  assert.ok(T.PASTE_DONE_NOTE.includes('do not re-read to verify and do not call replace_selection again'));
  assert.throws(() => JSON.parse(T.PASTE_DONE_NOTE));
});

test('the Edit rules promise the compact result and rule 11 says to add nothing after edits that succeeded', () => {
  const head = T.apiEditRules();
  assert.ok(head.includes('using the line numbers the previous edit returned'));
  assert.ok(head.includes('8. When every edit succeeded, add nothing: the edit cards already show what changed. Write only when an edit failed and you could not fix it, or when the user must decide something.'));
  assert.ok(!head.includes('one short sentence summarizing'));
  assert.ok(T.TOOLS_EDIT_RULES.includes('When it returns Done, add nothing: the edit card already shows what changed.'));
  assert.ok(!T.TOOLS_EDIT_RULES.includes('{"ok": true}'));
});
