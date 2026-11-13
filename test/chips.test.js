'use strict';
// Smart chips, dates, dropdowns and images: their notes in the reading output (a line label; line.text and every
// offset stay the API's) and the chip placeholders of the writing tools ({@email}, {date:YYYY-MM-DD}, {link:URL}):
// request shapes and index arithmetic per tool, verification, undo, the person gate, malformed placeholders.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, waitFor, load, installDocTab, installIdentity } = require('./lib/sandbox');
const { OC, docSpec, docsBench } = require('./lib/fake-docs');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, ident, fresh, exec, pushTool, lastPost;

before(async () => {
  env = await load();
  T = env.T;
  state = env.state;
  ident = installIdentity(env);
  ({ fresh, exec, pushTool, lastPost } = docsBench(env, ident, ref));
  installDocTab(env);
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic'; state.googleConnected = true;
});

// The offset of the n-th "￼" (0-based) of a text.
const objAt = (t, n = 0) => { let i = -1; for (let k = 0; k <= n; k++) i = t.indexOf(OC, i + 1); return i; };
const LONG_ALT = 'A bar chart of the quarterly budget by department, with the forecast for the next two quarters shown hatched';
const MEET = `Meet ${OC} about ${OC} on ${OC}.`;
const FIG = `Figure ${OC} and ${OC}`;
const chipSpec = () => docSpec({ items: [
  { p: 'Chips', style: 'TITLE' },
  { p: MEET, objects: [
    [objAt(MEET, 0), { person: { personId: 'p1', personProperties: { name: 'Anna Ivanova', email: 'anna@example.org' } } }],
    [objAt(MEET, 1), { richLink: { richLinkId: 'r1', richLinkProperties: { title: 'Q3 budget.xlsx', uri: 'https://docs.google.com/spreadsheets/d/abc', mimeType: 'application/vnd.google-apps.spreadsheet' } } }],
    [objAt(MEET, 2), { dateElement: { dateId: 'd1', dateElementProperties: { timestamp: '2026-11-12T11:00:00Z', displayText: 'Nov 12, 2026' } } }]] },
  { p: `Status: ${OC}`, objects: [[8, { dropdown: { dropdownId: 'dd1', dropdownProperties: { displayValue: 'In progress' } } }]] },
  { p: FIG, objects: [[objAt(FIG, 0), { image: { id: 'kix.a', title: 'Figure 2', description: LONG_ALT, width: 340.2, height: 226.8 } }],
    [objAt(FIG, 1), { image: { id: 'kix.b', width: 72, height: 72 } }]] },
  { p: `Plain ${OC} object` },
  { p: 'Results', style: 'HEADING_1' },
  { p: 'Old result text.' },
  { p: 'Last line' },
] });

const cards = () => [...T.pendingPreviews.entries()];
async function decided(promise, decision) {
  await waitFor(() => T.pendingPreviews.size === 1, 'the gate card');
  const [[id, p]] = cards();
  const html = p.card.innerHTML;
  assert.ok(T.decidePreview(id, decision));
  return { r: await promise, html };
}

test('reading: chips, dates, dropdowns and images get notes in the line label; text and offsets unchanged', async () => {
  await fresh(chipSpec());
  const m = as.model;
  // line.text keeps one "￼" per API index: the notes never enter the text
  deq(m.lines.slice(0, 5).map((l) => l.text), ['Chips', MEET, `Status: ${OC}`, FIG, `Plain ${OC} object`]);
  for (const l of m.lines) assert.strictEqual(l.text.length, l.end - l.start);
  assert.strictEqual(m.text.includes('⟨'), false);
  const lines = T.runReadingTool('read_lines', { start: 2, end: 5 }, as).split('\n');
  assert.strictEqual(lines[1], `2 [${OC}⟨@Anna Ivanova <anna@example.org>⟩ ${OC}⟨link: Q3 budget.xlsx⟩ ${OC}⟨date: Nov 12, 2026⟩]: ${MEET}`);
  assert.strictEqual(lines[2], `3 [${OC}⟨dropdown: In progress⟩]: Status: ${OC}`);
  // an image: size in cm, its title and the alt text (description) clipped; without either: "no alt text"
  assert.match(lines[3], new RegExp(`^4 \\[${OC}⟨image 12×8 cm: "Figure 2" alt: A bar chart of the quarterly budget by department, with the forecast for the ne…⟩ ${OC}⟨image 2\\.5×2\\.5 cm, no alt text⟩\\]: ${FIG}$`));
  // an object Docs does not describe (no inlineObjects entry) leaves the line as before
  assert.strictEqual(lines[4], `5: Plain ${OC} object`);
  // the same label in find_in_document, the formatting view and the edit reports
  assert.ok(T.runReadingTool('find_in_document', { query: 'status' }, as).includes(`3 [${OC}⟨dropdown: In progress⟩]: Status:`));
  assert.ok(T.runReadingTool('read_document', { scope: { start: 3, end: 3 }, include: ['formatting'] }, as).includes(`3 [${OC}⟨dropdown: In progress⟩]: `));
  assert.ok(T.linesReport(m, 3, 3).includes(`3 [${OC}⟨dropdown: In progress⟩]: Status: ${OC}`));
  // old_text around a chip still matches; a copied label is stripped like a line number
  let w = pushTool(await exec('replace_text', { old_text: `Meet ${OC} about`, new_text: `Ask ${OC} about` }, 'r1'));
  assert.ok(w._ok, w.content);
  assert.strictEqual(fake.text('t.0').split('\n')[1], `Ask ${OC} about ${OC} on ${OC}.`);
  deq(fake.objects('t.0')[1], [[4, 'person'], [12, 'richLink'], [17, 'dateElement']]); // the chips survived the edit
  w = await exec('replace_text', { old_text: `3 [${OC}⟨dropdown: In progress⟩]: Status:`, new_text: 'State:' });
  assert.ok(w._ok, w.content);
  assert.strictEqual(fake.text('t.0').split('\n')[2], `State: ${OC}`);
  assert.match(w.content, /formatting markers/);
});

test('reading: the line label survives the read-first line parser and the fields mask names the new fields', () => {
  assert.ok(/dateElement/.test(T.DOCS_GET_FIELDS) && /dropdown/.test(T.DOCS_GET_FIELDS) && /inlineObjects/.test(T.DOCS_GET_FIELDS));
  // gate.js reads "N [label]: " lines as seen; a chip label is one bracketed label
  assert.ok(/^(\d+)(?: \[[^\]\n]*\])*: /.test(`2 [${OC}⟨@Anna Ivanova <a@b.org>⟩]: Meet ${OC}`));
  // a bracket in a title cannot end the label early
  const line = T.buildLineModel({ documentId: 'D', tabs: [{ tabProperties: { tabId: 't' }, documentTab: { body: { content: [
    { startIndex: 1, endIndex: 3, paragraph: { elements: [{ startIndex: 1, endIndex: 2, richLink: { richLinkProperties: { title: 'Plan [draft] ⟨v2⟩', uri: 'https://drive.google.com/x' } } },
      { startIndex: 2, endIndex: 3, textRun: { content: '\n' } }] } }] } } }] }, 't', 'D').lines[0];
  assert.strictEqual(T.objectLabel(line), `[${OC}⟨link: Plan [draft v2⟩]`);
});

test('insert_after_line: {@email} and {date:…} become insertPerson / insertDate right after the text; verified; undone', async () => {
  await fresh(chipSpec());
  const total = as.model.lines.length;
  const last = as.model.lines[total - 1];
  const p = exec('insert_after_line', { line: total, text: 'Ask {@bob@example.org} by {date:2026-11-12}.', style: null }, 'i1');
  const { r, html } = await decided(p, 'accept'); // a person mention asks (it may notify the person)
  assert.match(html, /mentions bob@example\.org; Google Docs may notify this person/);
  const w = pushTool(r);
  assert.ok(w._ok, w.content);
  const reqs = lastPost().requests;
  const at = last.end; // after the last line: "\n" + text at its newline
  deq(reqs[0], { insertText: { location: { index: at, tabId: 't.0' }, text: '\nAsk  by .' } });
  deq(reqs[1], { insertPerson: { personProperties: { email: 'bob@example.org' }, location: { index: at + 5, tabId: 't.0' } } });
  const dp = reqs[2].insertDate.dateElementProperties;
  deq(reqs[2].insertDate.location, { index: at + 10, tabId: 't.0' });
  assert.match(dp.timestamp, /^2026-11-1[12]T\d\d:\d\d:00Z$/);
  assert.strictEqual(dp.timeZoneId, Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.strictEqual(dp.locale, 'en');
  assert.strictEqual(dp.timeFormat, 'TIME_FORMAT_DISABLED');
  // the chips are where the placeholders were; the re-read shows "￼" there and nothing was stored differently
  assert.strictEqual(fake.text('t.0').split('\n').pop(), `Ask ${OC} by ${OC}.`);
  deq(fake.objects('t.0').pop(), [[4, 'person'], [9, 'dateElement']]);
  assert.ok(!/stored the text differently/.test(w.content), w.content);
  assert.match(T.runReadingTool('read_lines', { start: total + 1, end: total + 1 }, as), new RegExp(`⟨@bob@example\\.org⟩ ${OC}⟨date: Nov 1[12], 2026⟩\\]: Ask`));
  assert.strictEqual(w._edit.text, `\nAsk ${OC} by ${OC}.`);
  assert.strictEqual(w._cardText, 'Ask {@bob@example.org} by {date:2026-11-12}.'); // the card shows what was asked for
  // undo deletes the range, chips included
  const u = pushTool(await exec('undo_last_edit', {}, 'u1'));
  assert.ok(u._ok, u.content);
  assert.strictEqual(fake.text('t.0').split('\n').length, total);
  assert.strictEqual(fake.text('t.0').split('\n').pop(), 'Last line');
});

test('replace_text: a date and a rich link in one text; another URL stays plain text with a note; no card without a person', async () => {
  await fresh(chipSpec());
  const line = as.model.lines.find((l) => l.text === 'Old result text.');
  const w = pushTool(await exec('replace_text', { old_text: 'Old result text.', new_text: 'Due {date:2027-01-05}, see {link:https://drive.google.com/file/d/xyz} and {link:https://example.org/a}.' }, 'r1'));
  assert.ok(w._ok, w.content);
  assert.strictEqual(w._decision, undefined); // no gate card
  const reqs = lastPost().requests;
  // commonEdges keeps nothing of "Old result text." but the final "."; the new middle starts at the line start
  deq(reqs[0], { deleteContentRange: { range: { startIndex: line.start, endIndex: line.start + 15, tabId: 't.0' } } });
  deq(reqs[1], { insertText: { location: { index: line.start, tabId: 't.0' }, text: 'Due , see  and https://example.org/a' } });
  deq(reqs[2].insertDate.location, { index: line.start + 4, tabId: 't.0' });
  deq(reqs[3], { insertRichLink: { richLinkProperties: { uri: 'https://drive.google.com/file/d/xyz' }, location: { index: line.start + 11, tabId: 't.0' } } });
  assert.strictEqual(reqs.length, 4);
  assert.strictEqual(fake.text('t.0').split('\n')[line.line - 1], `Due ${OC}, see ${OC} and https://example.org/a.`);
  deq(fake.objects('t.0')[line.line - 1], [[4, 'dateElement'], [11, 'richLink']]);
  assert.match(w.content, /\{link:https:\/\/example\.org\/a\} is not a Google Drive, YouTube or Calendar address, so it was written as plain text/);
  assert.ok(!/stored the text differently/.test(w.content), w.content);
  const u = pushTool(await exec('undo_last_edit', {}, 'u1'));
  assert.ok(u._ok, u.content);
  assert.strictEqual(fake.text('t.0').split('\n')[line.line - 1], 'Old result text.');
});

test('replace_section and edit_document: chip requests follow their text, edit_document bottom-up with shifted indices', async () => {
  await fresh(chipSpec());
  const body = as.model.lines.find((l) => l.text === 'Old result text.');
  let p = exec('replace_section', { heading: 'Results', new_text: 'Owner: {@cara@example.org}\nLast line' }, 's1');
  let res = await decided(p, 'accept');
  let w = pushTool(res.r);
  assert.ok(w._ok, w.content);
  let reqs = lastPost().requests;
  const ins = reqs.findIndex((r) => r.insertText);
  assert.strictEqual(reqs[ins].insertText.text.includes(OC), false);
  const at = reqs[ins].insertText.location.index;
  const off = `Owner: `.length + (reqs[ins].insertText.text.startsWith('\n') ? 1 : 0);
  deq(reqs[ins + 1], { insertPerson: { personProperties: { email: 'cara@example.org' }, location: { index: at + off, tabId: 't.0' } } });
  assert.strictEqual(fake.text('t.0').split('\n')[body.line - 1], `Owner: ${OC}`);
  // edit_document: an insert near the top and a replace further down, each with a chip
  await fresh(chipSpec());
  const old = as.model.lines.find((l) => l.text === 'Old result text.');
  p = exec('edit_document', { operations: [
    { op: 'insert', line: 1, text: 'By {@dan@example.org}', style: null },
    { op: 'replace', old_text: 'Old result', new_text: 'Seen {date:2026-12-01}' },
  ] }, 'e1');
  res = await decided(p, 'accept');
  w = pushTool(res.r);
  assert.ok(w._ok, w.content);
  reqs = lastPost().requests;
  // bottom-up: the replace (its own indices), then the insert at the end of line 1
  deq(reqs.slice(0, 4).map((r) => Object.keys(r)[0]), ['deleteContentRange', 'insertText', 'insertDate', 'insertText']);
  deq(reqs[1], { insertText: { location: { index: old.start, tabId: 't.0' }, text: 'Seen ' } });
  deq(reqs[2].insertDate.location, { index: old.start + 5, tabId: 't.0' });
  // line 1 "Chips" ends at index 6: "\nBy ￼" goes there, the person 4 positions in
  assert.ok(reqs.some((r) => r.insertPerson && r.insertPerson.location.index === 6 + 4 && r.insertPerson.personProperties.email === 'dan@example.org'), JSON.stringify(reqs));
  const lines = fake.text('t.0').split('\n');
  assert.strictEqual(lines[1], `By ${OC}`);
  assert.strictEqual(lines[old.line], `Seen ${OC} text.`);
  assert.ok(!/stored the text differently/.test(w.content), w.content);
  const u = pushTool(await exec('undo_last_edit', {}, 'u1'));
  assert.ok(u._ok, u.content);
  assert.strictEqual(fake.text('t.0').split('\n')[old.line - 1], 'Old result text.');
  assert.strictEqual(fake.text('t.0').split('\n')[1], MEET);
});

test('the person gate: asks in Auto with the whole new text; Deny leaves the document as it was; "Allow all in this turn" lets later mentions through', async () => {
  await fresh(chipSpec());
  const p = exec('insert_after_line', { line: 1, text: 'Hi {@eve@example.org}', style: null }, 'g1');
  const { r, html } = await decided(p, 'reject');
  assert.ok(!r._ok && /did not allow this edit/.test(r.content));
  assert.ok(html.includes('<div class="pv-note">It mentions eve@example.org; Google Docs may notify this person.</div>') && html.includes('<span class="code-lang">Inserted after line 1</span></div><pre>Hi {@eve@example.org}</pre>') && // the chip as typed

    !html.includes('Large edit'), html);
  assert.strictEqual(fake.revision, 1);
  as.editAll = true;
  const w = await exec('insert_after_line', { line: 1, text: 'Hello {@eve@example.org}', style: null }, 'g2');
  assert.strictEqual(T.pendingPreviews.size, 0);
  assert.ok(w._ok, w.content);
  as.editAll = undefined;
  // Manual: one card, the edit's, which names the person; Allow there lets it through (no second card)
  await fresh(chipSpec());
  as.askEdits = true;
  const m = await decided(exec('insert_after_line', { line: 1, text: 'Dear {@eve@example.org}', style: null }, 'g3'), 'accept');
  assert.ok(m.r._ok, m.r.content);
  assert.strictEqual(T.pendingPreviews.size, 0);
  assert.ok(m.html.includes('<div class="pv-note">Inserts text after line 1. It mentions eve@example.org; Google Docs may notify this person.</div>'), m.html);
});

test('malformed placeholders are errors naming the fix; replace_all refuses chips; the prompt line is in the Auto head', async () => {
  await fresh(chipSpec());
  let w = await exec('insert_after_line', { line: 1, text: 'Ask {@bob}', style: null });
  assert.ok(!w._ok && /\{@bob\} is not an email address; write a person chip as \{@name@example\.com\}/.test(w.content), w.content);
  w = await exec('replace_text', { old_text: 'Old result', new_text: 'On {date:2026-02-30}' });
  assert.ok(!w._ok && /\{date:2026-02-30\} is not a valid date; write a date chip as \{date:YYYY-MM-DD\}/.test(w.content), w.content);
  w = await exec('replace_section', { heading: 'Results', new_text: 'See {link:drive/abc}' });
  assert.ok(!w._ok && /is not a web address; write a link chip as \{link:https:\/\/…\}/.test(w.content), w.content);
  w = await exec('edit_document', { operations: [{ op: 'replace', old_text: 'Old result', new_text: '{date:12.11.2026}' }] });
  assert.ok(!w._ok && /operation 1 .*\{date:12\.11\.2026\} is not a valid date/.test(w.content), w.content);
  w = await exec('replace_all', { old_text: 'Last line', new_text: 'by {@bob@example.org}' });
  assert.ok(!w._ok && /replace_all cannot insert chips/.test(w.content), w.content);
  assert.strictEqual(fake.revision, 1);
  // text with braces that is no placeholder is written as it is
  w = await exec('replace_text', { old_text: 'Old result', new_text: 'Set {x} and {y:1}' });
  assert.ok(w._ok, w.content);
  assert.strictEqual(lastPost().requests.some((r) => r.insertPerson || r.insertDate || r.insertRichLink), false);
  const lines = T.extraPromptLines('edit', 'edit', as);
  assert.ok(lines.some((l) => /\{@email\} writes a person chip, \{date:YYYY-MM-DD\} a date chip, \{link:URL\}/.test(l)));
  deq(T.extraPromptLines('edit', 'manual', as).filter((l) => /chip/.test(l)), []);
});
