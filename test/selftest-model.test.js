'use strict';
// The model-driven part of the self-test (/test on an empty document, no confirmation card): scripted fake
// Munin streams do the scenarios on the fake Docs API (or, without Google, on a stub content script whose paste
// appends to the export); the panel verifies by re-reading. Covers the passing run on an empty document (the
// write cycle with the reading checks on its lines first), the "Empty document" gate (text in the document or
// a selection: nothing is written), a model that does the wrong thing, the panel's cleanup, the export mode,
// Stop (in a scenario and in the write cycle), the timeout, the chat history and the export requests (one read
// for two checks, re-reads only after a write, the 2 s spacing). The Your-turn cards are answered by a simulated
// user (b.user: select «brown fox», bold «quick», remove the paragraph; see test/selftest-interactive.test.js).
const { test } = require('node:test');
const assert = require('node:assert');
const { bench, call, say, PASTE, statusOf, HEAD, READING, WRITE_ROWS, MODEL_ROWS, API_ROWS, EXPORT_ROWS, deq, lines } = require('./lib/selftest-bench');
const { sseResponse } = require('./lib/streams');
const { docSpec, ORIGINAL } = require('./lib/fake-docs');


test('/test on an empty document: no permission card, the write cycle with the reading checks and the Your-turn steps on its lines, every scenario passes, the document ends empty, the chat is untouched', async () => {
  const b = await bench();
  const { T, state } = b;
  // a chat with history: it must be the same afterwards, in memory and in storage
  state.messages.push({ role: 'user', content: 'Earlier question' }, { role: 'assistant', content: 'Earlier answer' });
  await T.saveHistory({ docId: state.docId, chatId: state.chatId, messages: state.messages });
  const before = JSON.stringify(state.messages);
  const storedBefore = JSON.stringify(b.env.storage);
  const card = await b.run('/test');
  const rows = b.rows();
  deq(rows.map((r) => r.name), API_ROWS);
  assert.strictEqual(rows.length, 40);
  assert.strictEqual(new Set(rows.map((r) => r.name)).size, rows.length, 'one row per check');
  for (const r of rows) assert.strictEqual(r.status, 'pass', `${r.name}: ${r.detail} ${r.more || ''}`);
  deq(b.cards, [], 'no confirmation card');
  assert.strictEqual(b.fake.raw('t.0'), '', 'empty stays empty');
  assert.ok(!state.messages.some((x) => x._edit), 'no edit journal in the chat');
  assert.strictEqual(b.row('Empty document').detail, 'empty: 0 characters, 1 line (Docs API) · nothing selected · write cycle (revision rev-1, 1 line) · model scenarios (Docs API)');
  assert.strictEqual(b.row('Export read').detail, 'empty document: the export returned no text (markdown) · read by the panel · 1 export request in this self-test');
  // the write cycle and the reading checks, once, on its two lines
  assert.strictEqual(b.row('Write: insert_after_line').detail, 'lines 2–3 read «Self-test section» / «The quick brown fox jumps over the lazy …»');
  assert.strictEqual(b.row('get_outline').detail, 'no headings (the "no headings" note)');
  assert.strictEqual(b.row('read_lines').detail, 'lines 1–3 of 3; line 3 «The quick brown fox jumps over the lazy …»');
  assert.strictEqual(b.row('find_in_document').detail, '"quick" found on line 3');
  assert.strictEqual(b.row('get_selection').detail, 'selection simulated on line 3 (44 characters): lines 3-3');
  assert.strictEqual(b.row('read_formatting').detail, 'lines 2–3: 2 lines, plain text');
  assert.match(b.row('Matching').detail, /^line 3 «The quick brown fox jumps over the lazy …»: exact match, and with NBSP a normalized match at the same place$/);
  // the Your-turn steps on the write cycle's paragraph (the simulated user selects «brown fox», bolds «quick», types
  // and deletes «abc»)
  deq(b.turns.length, 3);
  assert.match(b.row('Your turn: typing signal').detail, /^DOC_TYPED ×3, DOC_CHANGED ×2 \(page 1, input 1\), estimate \+5 −5 chars, exact read after \d+\.\d s$/);
  assert.match(b.row('Change signal').detail, /^editor \.kix-appview-editor observed · hidden iframe listened to · so far: keys 3 in the iframe and 0 on the page, beforeinput 0, page changes 2$/);
  assert.strictEqual(b.row('Your turn: select text').detail, 'read «brown fox» (live)');
  assert.strictEqual(b.row('Model: replace the selection').detail, 'replace_selection replaced the selection «brown fox» through the Docs API; line 3 reads «The quick red cat jumps over the lazy do…» · 3 rounds · get_selection ×1, replace_selection ×1 · 330 tokens');
  assert.strictEqual(b.row('Your turn: make text bold').detail, 'read_formatting of line 3 shows **quick** (after 1 read)');
  deq(b.pastes, [], 'the selection was replaced through the Docs API, not pasted');
  // then the panel writes the paragraph again (plain) before the write cycle goes on
  assert.match(b.row('Write: replace_text').detail, /^line 3 reads «The slow green turtle.* · after the Your-turn steps the panel wrote line 3 again as «The quick brown fox/);
  assert.strictEqual(b.row('Write: format_text').detail, 'read_formatting shows line 3 with **lazy dog**');
  assert.strictEqual(b.row('Write: delete_lines').detail, 'lines 2–3 deleted; the document is empty again');
  assert.strictEqual(b.row('Write: text styles').detail, 'line 3: {***lazy dog***}(font=Courier New size=14 color=#FF0000 bg=#FFFF00), [turtle](https://example.com/); undone twice · Docs styled the link itself (underline, #1155CC)');
  assert.strictEqual(b.row('Write: format_lines').detail, 'line 2: [h2], then [h2 center space 12/6 line 1.5]; undone twice (style NORMAL_TEXT again)');
  assert.strictEqual(b.row('Write: lists').detail, 'lines 4–5: [number], [checklist], no tag; undone three times; the items deleted again');
  assert.match(b.row('Write: undo_last_edit').detail, /^inserted «Self-test undo line», undo_last_edit; the document is empty again · revision rev-1 → rev-47$/);
  const kinds = b.posts().map((x) => x.body.requests.map((q) => Object.keys(q)[0]).join('+'));
  // insert, the model's replace of the selection, the rewrite (delete + insert), replace_text, format_text,
  // (the text styles: 2 format_text, 2 undos), format_lines ×2 and 2 undos, the list items: insert, number,
  // checklist, none, 3 undos, their deletion; page parts (footer and footnote, two undos); delete_lines, the undo
  // line and its undo (the user's bold is an outside edit: no POST)
  deq(kinds.slice(0, 6), ['insertText', 'deleteContentRange+insertText', 'deleteContentRange+updateParagraphStyle', 'insertText',
    'deleteContentRange+insertText', 'updateTextStyle']);
  deq(kinds.slice(6, 10), ['updateTextStyle', 'updateTextStyle', 'updateTextStyle', 'updateTextStyle']);
  const at = 10;
  // Write: table (between the lists and delete_lines): insert and fill, a row and its text, a width, the row deleted; four undos
  const tableRows = ['insertTable', 'insertText+insertText+insertText+insertText', 'insertTableRow', 'insertText+insertText', 'updateTableColumnProperties',
    'deleteTableRow', 'insertTableRow', 'insertText+insertText', 'updateTableColumnProperties', 'deleteTableRow', 'deleteContentRange'];
  deq(kinds.slice(at, at + 34), ['updateParagraphStyle', 'updateParagraphStyle', 'updateParagraphStyle', 'updateParagraphStyle',
    'insertText', 'createParagraphBullets', 'deleteParagraphBullets+createParagraphBullets', 'deleteParagraphBullets+updateParagraphStyle',
    'createParagraphBullets+updateParagraphStyle', 'deleteParagraphBullets+createParagraphBullets+updateParagraphStyle', 'deleteParagraphBullets+updateParagraphStyle',
    'deleteContentRange+updateParagraphStyle',
    ...tableRows,
    'createFooter', 'insertText', 'createFootnote', 'insertText', 'deleteContentRange', 'deleteContentRange', 'deleteContentRange', 'deleteFooter',
    'deleteContentRange+updateParagraphStyle', 'insertText', 'deleteContentRange+updateParagraphStyle']);
  // checklist -> number on two items: the bullets deleted, then created with the numbered preset
  const toNumberUndo = b.posts()[at + 9].body.requests;
  deq(toNumberUndo.map((q) => q.createParagraphBullets && q.createParagraphBullets.bulletPreset).filter(Boolean), ['NUMBERED_DECIMAL_ALPHA_ROMAN']);
  assert.strictEqual(b.posts()[0].body.requests[0].insertText.text, '\nSelf-test section\nThe quick brown fox jumps over the lazy dog.');
  // the model scenarios: what was verified, rounds, tool calls, tokens
  assert.match(b.row('Model: write a section').detail, /^lines 2–3 read «Self-test section» \/ «The quick brown fox jumps over the lazy …» · 2 rounds · insert_after_line ×1 · 220 tokens$/);
  assert.match(b.row('Model: format').detail, /read_formatting shows line 3 with \*\*lazy dog\*\*/);
  assert.strictEqual(b.row('Model: heading').detail, 'line 2 is Heading 2: read_formatting shows «2: [h2] Self-test section» · 2 rounds · format_lines ×1 · 220 tokens');
  assert.strictEqual(b.row('Model: list').detail, 'lines 3–4 are a numbered list; the heading is not in it · 2 rounds · format_lines ×1 · 220 tokens');
  assert.match(b.row('Model: replace all').detail, /the panel added «A turtle is a turtle\.» as line 4; all 3 «turtle» became «tortoise»/);
  assert.match(b.row('Model: selection').detail, /line 3 is uppercase · selection simulated/);
  assert.match(b.row('Model: question').detail, /answered 3 \(correct\) after reading · 2 rounds · read_lines ×1/);
  assert.match(b.row('Model: delete').detail, /^the document is empty again · 2 rounds · delete_lines ×1/);
  assert.strictEqual(b.row('Model: cleanup').detail, 'the document is empty again');
  // each scenario is its own turn: its first request has one user message (the instruction with the turn
  // context), Auto mode with the writing tools, Manual for the question
  const firsts = b.bodies.filter((x, i) => b.keys[i].endsWith(':0') && !b.keys[i].startsWith('probe'));
  deq(firsts.map((x) => b.keys[b.bodies.indexOf(x)]), ['replaceSelection:0', 'write:0', 'replace:0', 'format:0', 'heading:0', 'replaceAll:0', 'list:0', 'selection:0', 'question:0', 'delete:0']);
  for (const x of firsts) assert.deepStrictEqual(x.messages.filter((m) => m.role !== 'system').map((m) => m.role), ['user']);
  const tools = (x) => x.tools.map((t) => t.function.name);
  assert.ok(tools(firsts[1]).includes('insert_after_line') && tools(firsts[1]).includes('replace_selection'));
  assert.ok(tools(firsts[4]).includes('format_lines'));
  assert.ok(!tools(firsts[8]).includes('insert_after_line') && tools(firsts[8]).includes('read_lines'), 'the question is Manual');
  assert.ok(firsts[1].messages[1].content.endsWith(T.ST_PROMPTS.write));
  assert.ok(firsts[0].messages[1].content.endsWith(T.ST_PROMPTS.replaceSelection));
  // the selection is given by its line and size only; the model reads its text with get_selection
  assert.ok(firsts[0].messages[1].content.includes('\nSelection: line 3 (9 characters)\n') && !firsts[0].messages[1].content.includes('brown fox'), 'the real selection is in the turn context by its line');
  assert.ok(firsts[7].messages[1].content.includes('\nSelection: line 3 (48 characters)\n'), 'the simulated selection is in the turn context by its line');
  // the report: the Model line and the summary
  const md = card._report;
  assert.ok(md.startsWith('## Munin self-test\n'));
  assert.match(md, /\n- Model: Munin \/ qwen3\.8-27b · 22 requests · 2,420 tokens \(2,200 in \/ 220 out\) · \d+\.\d s\n/);
  assert.match(md, /\*\*Summary:\*\* 40 passed, 0 warnings, 0 failed, 0 skipped/);
  assert.ok(card.innerHTML.includes('st-model'));
  assert.ok(!card.innerHTML.includes('Send this report to the developer'));
  // nothing reached the chat
  assert.strictEqual(JSON.stringify(state.messages), before);
  const stored = JSON.parse(storedBefore);
  for (const k of Object.keys(stored).filter((k) => k.startsWith('muninChatHistory'))) deq(b.env.storage[k], stored[k], k);
  assert.ok(!T.el.chat.children.some((c) => c && c.classList && c.classList.contains('assistant')), 'no chat bubbles');
  assert.strictEqual(state.selection, '');
  assert.strictEqual(state.busy, false);
});

test('/test on a document with text: only the harmless checks run, nothing is written, no model scenario runs', async () => {
  const b = await bench({ spec: docSpec() });
  await b.run('/test');
  const rows = b.rows();
  deq(rows.map((r) => r.name), API_ROWS);
  const gate = b.row('Empty document');
  assert.strictEqual(gate.status, 'fail');
  const text = ORIGINAL.join('\n');
  assert.strictEqual(gate.detail, `the document is not empty (${text.length} characters, 10 lines): open a new, empty Google Doc and run /test there`);
  for (const r of rows.slice(HEAD.length, -1)) deq([r.status, r.detail], ['skip', `not run: ${gate.detail}`], r.name);
  for (const n of HEAD.filter((x) => x !== 'Empty document')) assert.strictEqual(b.row(n).status, 'pass', n);
  assert.strictEqual(b.row('Multi-tab').status, 'pass');
  deq(b.posts(), [], 'no batchUpdate');
  deq(b.pastes, [], 'no REPLACE_SELECTION');
  deq(b.keys, ['probe:0'], 'the probe only');
  deq(b.cards, []);
  assert.strictEqual(b.fake.text('t.0'), text);
  assert.match(b.card()._report, /\*\*Summary:\*\* 9 passed, 0 warnings, 1 failed, 30 skipped/);
  deq(b.turns, [], 'no Your-turn card');
  assert.ok(!b.card()._report.includes('- Model:'));
});

test('/test without a Google account on a document with text: the same stop, measured on the export', async () => {
  const b = await bench({ connected: false });
  b.doc = 'Some text here.\n\nMore.\n';
  await b.run('/test');
  deq(b.rows().map((r) => r.name), EXPORT_ROWS);
  const gate = b.row('Empty document');
  assert.strictEqual(gate.detail, 'the document is not empty (23 characters, 4 lines): open a new, empty Google Doc and run /test there');
  for (const r of b.rows().slice(HEAD.length, -1)) deq([r.status, r.detail], ['skip', `not run: ${gate.detail}`], r.name);
  deq(b.pastes, []);
  deq(b.keys, ['probe:0']);
  assert.match(b.row('Export read').detail, / · 1 export request in this self-test$/);
});

test('/test: text selected in an empty document stops the run before anything is written', async () => {
  for (const connected of [true, false]) {
    const b = await bench({ connected, selection: 'some words' });
    await b.run('/test');
    const gate = b.row('Empty document');
    assert.strictEqual(gate.status, 'fail');
    assert.strictEqual(gate.detail, 'text is selected in the document (10 characters): click once in the document so that nothing is selected, then run /test again (a paste would replace the selection)');
    for (const r of b.rows().slice(HEAD.length, -1)) deq([r.status, r.detail], ['skip', `not run: ${gate.detail}`], r.name);
    deq(b.posts(), [], 'no batchUpdate');
    deq(b.pastes, [], 'no REPLACE_SELECTION');
    deq(b.keys, ['probe:0']);
  }
});

test('/test: a model that does the wrong thing fails with its answer and the dependents are skipped', async () => {
  const b = await bench({ script: { write: [() => say('Sure! Here is the section:\n\nSelf-test section\nThe quick brown fox jumps over the lazy dog.')] } });
  await b.run('/test');
  const s = statusOf(b.rows());
  assert.strictEqual(s['Model: write a section'], 'fail');
  const w = b.row('Model: write a section');
  assert.match(w.detail, /the last two lines are not «Self-test section» and the fox paragraph · 1 round · no tool calls · 110 tokens · answer «Sure! Here is the section: Self-test section The quick brown fox/);
  assert.match(w.detail, /The document is empty again\.$/);
  assert.match(w.more, /Answer: «Sure!/);
  for (const n of ['Model: replace a phrase', 'Model: format', 'Model: heading', 'Model: replace all', 'Model: list', 'Model: selection', 'Model: question']) {
    assert.strictEqual(b.row(n).detail, 'not run: the model did not write the self-test section', n);
  }
  for (const n of READING) assert.strictEqual(s[n], 'pass', n); // they ran on the write cycle's lines
  assert.strictEqual(b.row('Model: delete').detail, 'not run: there is no self-test section');
  assert.strictEqual(b.row('Model: cleanup').detail, 'the document is empty again');
  assert.deepStrictEqual(b.keys.filter((k) => k !== 'probe:0'), ['replaceSelection:0', 'replaceSelection:1', 'replaceSelection:2', 'write:0'], 'no further scenario requests');
  assert.strictEqual(b.fake.raw('t.0'), '');
  assert.ok(b.card().innerHTML.includes('Send this report to the developer'));
});

test('/test: a failed scenario lists the tool calls it made, with the arguments as compact JSON and the first result line', async () => {
  const bad = () => call('format_text', { old_text: 'lazy dog', bold: 'maybe', italic: null, underline: null });
  const b = await bench({ script: { format: [bad, bad, () => call('read_formatting', { start: 1, end: 3 }), () => say('I could not make it bold.')] } });
  await b.run('/test');
  const f = b.row('Model: format');
  assert.strictEqual(f.status, 'fail', f.detail);
  const trace = f.more.slice(f.more.indexOf('Tool calls:'));
  assert.ok(trace.startsWith('Tool calls:\n1. format_text({"old_text":"lazy dog","bold":"maybe","italic":null,"underline":null}) → Error: bold must be true, false or null (JSON booleans); got the string "maybe"\n' +
    '2. format_text({"old_text":"lazy dog","bold":"maybe","italic":null,"underline":null}) → Error: bold must be'), trace);
  assert.match(trace, /\n3\. read_formatting\(\{"start":1,"end":3\}\) → /);
  // the scenarios that passed have no trace
  assert.ok(!(b.row('Model: replace a phrase').more || '').includes('Tool calls:'));
  // a long run: at most 12 calls, each clipped
  const many = await bench({ script: { format: [() => call('format_text', { old_text: 'lazy dog ' + 'x'.repeat(300), bold: true, italic: null, underline: null })] } });
  await many.run('/test');
  const m = many.row('Model: format');
  assert.ok(m.status === 'fail' || m.status === 'warn', m.detail);
  const rows = m.more.slice(m.more.indexOf('Tool calls:')).split('\n').slice(1);
  assert.strictEqual(rows.filter((r) => /^\d+\. /.test(r)).length, 12, rows.join('\n'));
  assert.ok(rows.every((r) => r.length < 450), rows.join('\n'));
});

test('/test: loose arguments still pass: markers and "true" strings in format_text, a repeated format_lines gets the repeat guard', async () => {
  const b = await bench({ script: {
    format: [() => call('format_text', { old_text: '**lazy dog**', bold: 'true', italic: 'null', underline: null }), () => say('Done.')],
    heading: [
      (x) => call('format_lines', { ...lines(x.lines().indexOf('Self-test section') + 1, x.lines().indexOf('Self-test section') + 1, { style: 'Heading 2' }), align: 'null', list: '' }),
      (x) => call('format_lines', lines(x.lines().indexOf('Self-test section') + 1, x.lines().indexOf('Self-test section') + 1, { style: 'h2' })),
      () => say('Done.')],
  } });
  await b.run('/test');
  const f = b.row('Model: format');
  assert.strictEqual(f.status, 'pass', f.detail);
  const h = b.row('Model: heading');
  assert.strictEqual(h.status, 'pass', `${h.detail} ${h.more || ''}`);
  assert.match(h.detail, / · 3 rounds · format_lines ×2 · /);
  const results = b.bodies.flatMap((x) => x.messages.filter((m) => m.role === 'tool').map((m) => String(m.content)));
  assert.ok(results.some((c) => c.startsWith('Done: formatted line 2 (h2).')), results.join('\n---\n'));
  assert.ok(results.some((c) => c.startsWith('Already done in this message: formatted line 2 (h2). Do not call format_lines again for this.')), results.join('\n---\n'));
  assert.strictEqual(b.row('Model: cleanup').status, 'pass');
});

test('/test: the formatting scenarios\' verdicts: another heading level warns, no heading fails; bullets warn, typed numbers fail', async () => {
  const head = (x) => x.lines().indexOf('Self-test section') + 1;
  let b = await bench({ script: {
    heading: [(x) => call('format_lines', lines(head(x), head(x), { style: 'h3' })), () => say('Done.')],
    list: [(x) => call('format_lines', lines(head(x) + 1, head(x) + 2, { list: 'bullet' })), () => say('Done.')],
  } });
  await b.run('/test');
  let r = b.row('Model: heading');
  deq([r.status, r.detail.split(' · ')[0]], ['warn', 'line 2 is HEADING_3, not HEADING_2']);
  assert.match(r.more, /Tool calls:\n1\. format_lines\(/);
  r = b.row('Model: list');
  deq([r.status, r.detail.split(' · ')[0]], ['warn', 'lines 3–4 are a list, but bullet / bullet instead of numbered']);
  assert.strictEqual(b.row('Model: selection').status, 'pass');
  b = await bench({ script: {
    heading: [() => say('It is a heading now.')],
    list: [() => call('replace_text', { old_text: 'The slow green tortoise', new_text: '1. The slow green tortoise' }), () => say('Done.')],
  } });
  await b.run('/test');
  r = b.row('Model: heading');
  deq([r.status, r.detail.split(' · ')[0]], ['fail', 'line 2 is not a heading (NORMAL_TEXT)']);
  r = b.row('Model: list');
  assert.strictEqual(r.status, 'fail');
  assert.match(r.detail, /^line 3 reads «1\. The slow green tortoise jumps over th…», expected «The slow green tortoise jumps over the l…»/);
  assert.strictEqual(b.row('Model: selection').detail, 'not run: an earlier scenario changed the section unexpectedly');
  assert.strictEqual(b.row('Model: cleanup').status, 'pass');
  assert.strictEqual(b.fake.raw('t.0'), '');
});

test('/test: "Write: lists" with a missing tag prints the raw bullet and nesting level from a fresh documents.get', async () => {
  const b = await bench();
  // a Docs whose numbered levels carry no glyphType: the panel classifies them as checklist
  const render = b.fake.render;
  b.fake.render = (tabs) => {
    const doc = render(tabs);
    for (const t of doc.tabs || []) for (const l of Object.values(t.documentTab.lists || {})) for (const lv of l.listProperties.nestingLevels) delete lv.glyphType;
    return doc;
  };
  await b.run('/test');
  const r = b.row('Write: lists');
  assert.strictEqual(r.status, 'fail');
  assert.match(r.detail, /^list number: lines 4–5 read 4: \[checklist\] Item one \/ 5: \[checklist\] Item two, expected \[number\] · Left in the document: /);
  assert.ok(r.more.startsWith('Raw: line 4 bullet {"listId":"kix.list.1"} level {"glyphFormat":"%0."}; line 5 bullet {"listId":"kix.list.1"} level {"glyphFormat":"%0."}'), r.more);
  assert.strictEqual(b.row('Write: delete_lines').detail, 'not run: an earlier write step failed');
});

test('/test: when the model does not delete the section, the panel cleans up', async () => {
  const b = await bench({ script: { delete: [() => say('I cannot delete text in this document.')] } });
  await b.run('/test');
  const d = b.row('Model: delete');
  assert.strictEqual(d.status, 'fail');
  assert.match(d.detail, /^the document differs from the original \(it is not empty\) · 1 round · no tool calls · 110 tokens · answer «I cannot delete text in this document\.» · Left in the document: line 2 «Self-test section», line 3 «THE SLOW GREEN TORTOISE JUMPS OVER THE LAZY DOG\.», line 4 «A tortoise is a tortoise\.»\.$/);
  const c = b.row('Model: cleanup');
  assert.strictEqual(c.status, 'pass');
  assert.strictEqual(c.detail, 'cleaned up by the panel: deleted lines 2–4; the document is empty again');
  assert.strictEqual(b.fake.raw('t.0'), '');
  for (const n of MODEL_ROWS.filter((x) => !['Model: delete', 'Model: cleanup'].includes(x))) assert.strictEqual(b.row(n).status, 'pass', `${n}: ${b.row(n).detail}`);
});

test('/test: the panel does not delete lines that are not test text', async () => {
  const b = await bench({ script: { delete: [() => call('insert_after_line', { line: 1, text: 'Unrelated line' }), () => say('Done.')] } });
  await b.run('/test');
  const c = b.row('Model: cleanup');
  assert.strictEqual(c.status, 'fail');
  assert.match(c.detail, /^the panel cannot restore this safely · Left in the document: line 2 «Unrelated line», line 3 «Self-test section»/);
  assert.ok(b.fake.raw('t.0').includes('Unrelated line'));
});

test('/test without a Google account on an empty document: paste at the cursor, the reading checks and the Your-turn steps on it, the question, the removal by the user', async () => {
  const b = await bench({ connected: false });
  await b.run('/test');
  const rows = b.rows();
  deq(rows.map((r) => r.name), EXPORT_ROWS);
  const s = statusOf(rows);
  assert.strictEqual(b.row('Empty document').detail, 'empty: 0 characters, 1 line (export, markdown) · nothing selected · no write cycle (needs a connected Google account) · model scenarios (export only: a paste at the cursor and a question)');
  for (const n of WRITE_ROWS) deq([s[n], b.row(n).detail], ['skip', 'not run: needs a connected Google account'], n);
  const ins = b.row('Model: insert at the cursor');
  assert.strictEqual(ins.status, 'pass', ins.detail);
  assert.match(ins.detail, /^replace_selection pasted it where the cursor was; the export shows it on line 1 · text 65 characters · pasted once · 1 call · 1 insertion attempt · 2 rounds · replace_selection ×1/);
  // the first paste has no "expected" (nothing was selected); the second goes over the user's selection
  deq(b.pastes, [{ type: 'REPLACE_SELECTION', text: PASTE }, { type: 'REPLACE_SELECTION', text: 'red cat', expected: 'brown fox' }]);
  assert.strictEqual(b.row('Your turn: select text').detail, 'read «brown fox» (live)');
  assert.match(b.row('Model: replace the selection').detail, /^replace_selection replaced the selection «brown fox» through the paste over the selection; line 1 reads «Self-test paragraph: the quick red cat j…» · 3 rounds · get_selection ×1, replace_selection ×1/);
  assert.strictEqual(b.row('Your turn: make text bold').detail, 'the Markdown export of line 1 shows **quick** (formatting read from the Markdown export)');
  for (const n of READING.filter((x) => x !== 'read_formatting')) assert.strictEqual(s[n], 'pass', `${n}: ${b.row(n).detail}`);
  assert.strictEqual(b.row('read_lines').detail, 'lines 1–2 of 2; line 1 «Self-test paragraph: the quick brown fox…»');
  assert.strictEqual(b.row('find_in_document').detail, '"Self" found on line 1');
  assert.strictEqual(b.row('get_selection').detail, 'selection simulated on line 1 (65 characters): lines 1-1');
  deq([s.read_formatting, b.row('read_formatting').detail], ['skip', 'needs a Google account (Docs API)']);
  assert.match(b.row('Model: question').detail, /answered 1 \(correct\) after reading · 2 rounds · find_in_document ×1/);
  for (const n of ['Your turn: select text', 'Model: replace the selection', 'Your turn: make text bold']) assert.strictEqual(s[n], 'pass', `${n}: ${b.row(n).detail}`);
  deq([s['Your turn: remove the test text'], b.row('Your turn: remove the test text').detail], ['pass', 'removed by the user; the document is empty again']);
  assert.strictEqual(b.doc, '');
  assert.ok(!b.bodies.some((x) => (x.tools || []).some((t) => t.function.name === 'insert_after_line')), 'no Docs API tools offered');
  deq(b.cards, []);
  assert.match(b.card()._report, /- Model: Munin \/ qwen3\.8-27b · 7 requests/);
  assert.match(b.card()._report, /\*\*Summary:\*\* 21 passed, 0 warnings, 0 failed, 10 skipped/);
});

test('/test without a Google account: the paste inserted three times for one call fails "pasted 3 times", the later rows still run', async () => {
  const b = await bench({ connected: false, pasteTimes: 3 });
  await b.run('/test');
  deq(b.rows().map((r) => r.name), EXPORT_ROWS);
  const s = statusOf(b.rows());
  const ins = b.row('Model: insert at the cursor');
  assert.strictEqual(ins.status, 'fail');
  assert.match(ins.detail, /^pasted 3 times: the content script inserted 3 times for one call · 1 call · 3 insertion attempts · 2 rounds · replace_selection ×1/);
  deq(b.pastes.length, 2); // the insert and the replace of the selection
  // the reading rows run on the tripled line (195 characters); Matching finds no unique text on it
  assert.strictEqual(b.row('get_selection').detail, 'selection simulated on line 1 (195 characters): lines 1-1');
  for (const n of ['get_outline', 'read_lines', 'find_in_document', 'get_selection']) assert.strictEqual(s[n], 'pass', `${n}: ${b.row(n).detail}`);
  deq([s.Matching, b.row('Matching').detail], ['skip', 'line 1 has no unique text with an inner space']);
  assert.strictEqual(s['Model: question'], 'pass', b.row('Model: question').detail);
  // the selection is replaced in one of the three copies: «brown fox» once fewer, «red cat» once more than before
  // the step (the copies the failed insert left are not this step's failure)
  deq([s['Model: replace the selection'], b.row('Model: replace the selection').detail.split(' · ')[0]],
    ['pass', 'replace_selection replaced the selection «brown fox» through the paste over the selection; line 1 reads «Self-test paragraph: the quick red cat j…»']);
  assert.strictEqual(s['Your turn: remove the test text'], 'pass');
});

test('/test without a Google account: a model that sends the paragraph three times is named as the cause', async () => {
  const b = await bench({ connected: false, script: { insert: [() => call('replace_selection', { text: `${PASTE} ${PASTE} ${PASTE}` }), () => say('Inserted.')] } });
  await b.run('/test');
  const ins = b.row('Model: insert at the cursor');
  assert.strictEqual(ins.status, 'fail');
  assert.match(ins.detail, /^pasted 3 times: the model sent the paragraph 3 times \(one call, 197 characters\) · 1 call · 1 insertion attempt · /);
});

test('/test without a Google account: the content script inserting twice for one call is named as the cause', async () => {
  const b = await bench({ connected: false, pasteTimes: 2 });
  await b.run('/test');
  const ins = b.row('Model: insert at the cursor');
  assert.strictEqual(ins.status, 'fail');
  assert.match(ins.detail, /^pasted 2 times: the content script inserted 2 times for one call · 1 call · 2 insertion attempts · 2 rounds · replace_selection ×1/);
});

test('/test without a Google account: a second replace_selection in the turn is refused by the panel; the row passes with a warning detail', async () => {
  const b = await bench({ connected: false, script: { insert: [() => call('replace_selection', { text: PASTE }), () => call('replace_selection', { text: PASTE }), () => say('Inserted.')] } });
  await b.run('/test');
  const ins = b.row('Model: insert at the cursor');
  assert.strictEqual(ins.status, 'pass', ins.detail);
  assert.match(ins.detail, /^replace_selection pasted it where the cursor was; the export shows it on line 1 · text 65 characters · pasted once · 2 calls · 1 insertion attempt · second call refused by the panel · 3 rounds · replace_selection ×2/);
  deq(b.pastes.map((p) => p.text), [PASTE, 'red cat']); // the refused call sent nothing to the document
  // the model got the refusal
  const refusal = b.bodies.find((x) => x.messages.some((m) => m.role === 'tool' && m.content === b.T.PASTE_AGAIN_TEXT));
  assert.ok(refusal, 'the refusal reached the model');
  assert.strictEqual(b.row('Model: replace the selection').status, 'pass', b.row('Model: replace the selection').detail);
});

test('the paste verdict: several pasted calls are the model\'s behavior, with the characters per call', async () => {
  const b = await bench({ connected: false });
  const { T } = b;
  const tc = (id, text) => ({ id, type: 'function', function: { name: 'replace_selection', arguments: JSON.stringify({ text }) } });
  const history = [
    { role: 'user', content: 'x' },
    { role: 'assistant', content: null, tool_calls: [tc('a', PASTE)] }, { role: 'tool', tool_call_id: 'a', content: '{}', _ok: true, _attempts: 1 },
    { role: 'assistant', content: null, tool_calls: [tc('b', PASTE)] }, { role: 'tool', tool_call_id: 'b', content: '{}', _ok: true, _attempts: 1 },
    { role: 'assistant', content: null, tool_calls: [tc('c', PASTE)] }, { role: 'tool', tool_call_id: 'c', content: '{}', _ok: true, _attempts: 1 },
  ];
  const v = T.stPasteVerdict({ history }, `${PASTE}\n\n${PASTE}\n\n${PASTE}\n`);
  assert.strictEqual(v.fail, true);
  assert.strictEqual(v.detail, 'pasted 3 times: the model called replace_selection 3 times (65 characters each); each call was pasted once (a model behavior failure) · 3 calls · 3 insertion attempts');
  const once = T.stPasteVerdict({ history: history.slice(0, 3) }, `${PASTE}\n`);
  deq([once.fail, once.detail], [false, 'text 65 characters · pasted once · 1 call · 1 insertion attempt']);
});

test('/test: Stop mid-scenario ends the run and the panel cleans up', async () => {
  const b = await bench({
    onRequest: (x, key) => {
      if (key !== 'format') return null;
      x.state.abort.abort();
      return sseResponse(say('...'));
    },
  });
  await b.run('/test');
  const rows = b.rows();
  assert.strictEqual(rows[rows.length - 1].name, 'Model: format');
  assert.strictEqual(rows[rows.length - 1].detail, 'stopped');
  assert.ok(b.card()._selfTest.stopped);
  assert.match(b.card()._report, /\*\*Model scenarios:\*\* Stopped: cleaned up by the panel: deleted lines 2–3; the document is empty again\./);
  assert.strictEqual(b.fake.raw('t.0'), '');
  assert.strictEqual(b.state.busy, false);
  assert.ok(!b.keys.some((k) => k.startsWith('replaceAll')));
});

test('/test: Stop during the write cycle ends the run and the panel deletes the test lines', async () => {
  const b = await bench();
  const real = b.fake.fetch;
  let posts = 0;
  b.fake.fetch = async (url, init = {}) => {
    const r = await real(url, init);
    // after replace_text: insert, the model's replace of the selection, the rewrite (2), replace_text
    if (init.method === 'POST' && /docs\.googleapis/.test(url) && ++posts === 5) b.state.abort.abort();
    return r;
  };
  await b.run('/test');
  const rows = b.rows();
  assert.strictEqual(rows[rows.length - 1].name, 'Write: replace_text');
  assert.ok(b.card()._selfTest.stopped);
  assert.match(b.card()._report, /\*\*Write cycle:\*\* Stopped: cleaned up by the panel: deleted lines 2–3; the document is empty again\./);
  assert.strictEqual(b.fake.raw('t.0'), '');
  deq(b.keys, ['probe:0', 'replaceSelection:0', 'replaceSelection:1', 'replaceSelection:2'], 'no scenario after Stop');
  assert.strictEqual(b.state.busy, false);
});

test('/test: a scenario that does not answer in time fails with the timeout and the section is deleted', async () => {
  const b = await bench({
    onRequest: (x, key, round, init) => (key !== 'replace' ? null : new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => { const e = new Error('The operation was aborted.'); e.name = 'AbortError'; reject(e); });
    })),
  });
  b.T.ST_MODEL.timeoutMs = 80;
  await b.run('/test');
  const r = b.row('Model: replace a phrase');
  assert.strictEqual(r.status, 'fail');
  assert.match(r.detail, /^timed out after 0\.1 s · 0 rounds · no tool calls · no usage reported · answer «\(empty\)» · Left in the document: line 2 «Self-test section», line 3/);
  assert.strictEqual(b.row('Model: format').detail, 'not run: an earlier scenario changed the section unexpectedly');
  assert.strictEqual(b.row('Model: delete').status, 'pass');
  assert.strictEqual(b.row('Model: cleanup').status, 'pass');
  assert.strictEqual(b.fake.raw('t.0'), '');
  assert.ok(!b.card()._selfTest.stopped);
});

test('/test: the Export read row names the route that delivered the text', async () => {
  const b = await bench({ connected: false });
  await b.run('/test');
  let r = b.row('Export read');
  assert.strictEqual(r.status, 'pass');
  assert.strictEqual(r.detail, 'empty document: the export returned no text (markdown) · read by the panel · 8 export requests in this self-test');
  // the panel's own export fails: the content script's export stands in (a warning naming the panel's error)
  const c = await bench({ connected: false, panelExportStatus: 500 });
  c.doc = 'Some text here.\n';
  await c.run('/test');
  r = c.row('Export read');
  assert.strictEqual(r.status, 'warn');
  assert.strictEqual(r.detail, "16 characters · markdown · 2 lines · read by the content script (the panel's export failed) · 3 export requests in this self-test");
  assert.match(r.more, /The panel's own export failed \(HTTP 500\); the content script's export worked/);
  assert.strictEqual(c.row('Empty document').detail, 'the document is not empty (16 characters, 2 lines): open a new, empty Google Doc and run /test there');
});

test('/test without a Google account: one export read for Export read and the gate, re-reads only after a write, spaced 2 s apart', async () => {
  const b = await bench({ connected: false });
  await b.run('/test');
  assert.strictEqual(b.row('Model: insert at the cursor').status, 'pass');
  assert.strictEqual(b.row('Model: question').status, 'pass');
  // Export read (1), after the paste (1), the replace scenario's turn read after the selection card (1), its
  // verification (1), the bold check (1), the typing signal's read that saw the letters (1), the question's read
  // after that card (1), the removal check (1): the gate, the reading checks and the other scenario starts reuse
  // the last read
  deq(b.events.filter((e) => e === 'export').length, 8);
  assert.match(b.row('Export read').detail, / · 8 export requests in this self-test$/);
  // every export read after the first waits for the rest of the 2 s gap first
  b.events.forEach((e, i) => {
    if (e !== 'export' || i === b.events.indexOf('export')) return;
    const wait = /^sleep (\d+)$/.exec(b.events[i - 1] || '');
    assert.ok(wait && Number(wait[1]) > 1500 && Number(wait[1]) <= 2000, `a wait before export #${i}: ${b.events.join(', ')}`);
  });
  assert.strictEqual(b.state.exportPace, null); // the scheduler is removed after the run
});

test('/test without a Google account: the verification re-reads the export twice at most, 3 s apart', async () => {
  const b = await bench({ connected: false, script: { insert: [() => call('replace_selection', { text: 'Something else entirely.' }), () => say('Done.')] } });
  b.T.ST_MODEL.exportWaitMs = 3000;
  const T0 = Date.now();
  const delays = [];
  const setT = b.ctx.setTimeout;
  b.ctx.setTimeout = (fn, ms, ...a) => { if (ms === 3000) { delays.push(ms); return setT(fn, 0, ...a); } return setT(fn, ms, ...a); };
  await b.run('/test');
  b.ctx.setTimeout = setT;
  const ins = b.row('Model: insert at the cursor');
  assert.strictEqual(ins.status, 'fail');
  assert.strictEqual(b.T.ST_MODEL.exportTries, 2);
  deq(delays, [3000]); // two tries, one 3 s pause between them
  assert.ok(Date.now() - T0 < 2000, 'no real waits');
  for (const n of READING) assert.strictEqual(b.row(n).detail, 'not run: the test paragraph was not inserted', n);
});
