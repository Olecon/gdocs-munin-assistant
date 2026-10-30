'use strict';
// The read-first check (gate.js, a beforeWrite hook): in a visible main-chat turn (toolLoop sets snap.readFirst) a
// replace_section or delete_lines over lines the model has not seen in this message (no read_lines, read_formatting,
// find_in_document, get_selection or edit report showed them: noteSeenLines) is refused once, with the current text of
// those lines (all of them up to 10, else the first and last 5; 120 characters each); the identical call again passes.
// Empty lines and the section's heading need no reading; insert and format tools, opened documents and the panel's own
// calls (no snap.readFirst) are not checked.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, waitFor, load, installDocTab, installIdentity } = require('./lib/sandbox');
const { sseResponse, tu, msgStart, stopTool, textRound } = require('./lib/streams');
const { fakeDocsServer, docSpec, docsBench } = require('./lib/fake-docs');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, sandbox, chrome, ident, fresh, exec, routeDocs;

// Title, "Methods" (H1) with 14 body lines (one empty), "Results" (H1) with one line.
const LONG_LINE = 'x'.repeat(200);
const sectionSpec = () => docSpec({ items: [
  { p: 'Paper', style: 'TITLE' },
  { p: 'Methods', style: 'HEADING_1' },
  ...Array.from({ length: 14 }, (_, k) => ({ p: k === 6 ? '' : k === 0 ? LONG_LINE : `Method line ${k + 3}.` })),
  { p: 'Results', style: 'HEADING_1' },
  { p: 'It worked.' },
] });
const REFUSED = 'Refused by a check: you have not read';

before(async () => {
  env = await load();
  T = env.T;
  state = env.state;
  sandbox = env.ctx;
  chrome = env.chrome;
  ident = installIdentity(env);
  ({ fresh, exec, routeDocs } = docsBench(env, ident, ref));
  installDocTab(env);
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic'; state.googleConnected = true;
});

async function freshTurn(spec) {
  await fresh(spec);
  as.readFirst = true; // as in a visible turn (toolLoop)
}
async function allowCard(promise) {
  await waitFor(() => T.pendingPreviews.size === 1, 'the gate card');
  const [[id]] = [...T.pendingPreviews.entries()];
  T.decidePreview(id, 'accept');
  return promise;
}

test('delete_lines over unread lines: refused once with the current text; the identical call then passes', async () => {
  await freshTurn(sectionSpec());
  const r1 = await exec('delete_lines', { start: 4, end: 5 });
  assert.strictEqual(r1._ok, false);
  assert.strictEqual(r1.content, `${REFUSED} lines 4–5 in this message. They currently say:\n4: Method line 4.\n5: Method line 5.\n` +
    'Read them with read_lines if you need more, then call the tool again.');
  assert.strictEqual(fake.text('t.0').split('\n').length, 18, 'nothing deleted');
  const r2 = await exec('delete_lines', { start: 4, end: 5 });
  assert.ok(r2._ok, r2.content);
  assert.ok(!fake.text('t.0').includes('Method line 4.'));
});

test('the excerpt of a long span: first and last 5 lines, 120 characters each; the empty line and the heading need no read', async () => {
  await freshTurn(sectionSpec());
  const r = await exec('replace_section', { heading: 'Methods', new_text: 'One line.' });
  assert.strictEqual(r._ok, false);
  const lines = r.content.split('\n');
  assert.strictEqual(lines[0], `${REFUSED} lines 3–16 in this message. They currently say:`);
  assert.strictEqual(lines[1], `3: ${'x'.repeat(120)}…`);
  deq(lines.slice(2, 6), ['4: Method line 4.', '5: Method line 5.', '6: Method line 6.', '7: Method line 7.']);
  assert.strictEqual(lines[6], '[lines 8–11 not shown]');
  deq(lines.slice(7, 12), ['12: Method line 12.', '13: Method line 13.', '14: Method line 14.', '15: Method line 15.', '16: Method line 16.']);
  assert.strictEqual(T.pendingPreviews.size, 0, 'no card for a refused call');
});

test('after a read the write passes at once: read_lines, find_in_document, get_selection', async () => {
  await freshTurn(sectionSpec());
  await exec('read_lines', { start: 3, end: 16 });
  const r = await allowCard(exec('replace_section', { heading: 'Methods', new_text: 'One line.' }));
  assert.ok(r._ok, r.content);
  // find_in_document shows the lines it finds
  await freshTurn(sectionSpec());
  await exec('find_in_document', { query: 'Method line 1' });
  assert.ok([10, 11, 12, 13, 14, 15, 16].every((n) => as.seenLines.has(n)));
  const d = await exec('delete_lines', { start: 12, end: 13 });
  assert.ok(d._ok, d.content);
  // get_selection: the selected lines
  await freshTurn(sectionSpec());
  as.selection = 'Method line 4.\nMethod line 5.';
  await exec('get_selection', {});
  assert.ok(as.seenLines.has(4) && as.seenLines.has(5));
  assert.ok((await exec('delete_lines', { start: 4, end: 5 }))._ok);
  // a part read: only the unread lines are named
  await freshTurn(sectionSpec());
  await exec('read_lines', { start: 3, end: 10 });
  const part = await exec('delete_lines', { start: 9, end: 12 });
  assert.ok(part.content.startsWith(`${REFUSED} lines 11–12 in this message.`), part.content);
});

test('no effect when every line was read (a document read whole), for insert and format tools, or without snap.readFirst', async () => {
  await freshTurn(sectionSpec());
  await exec('read_lines', { start: 1, end: 18 });
  assert.ok((await exec('delete_lines', { start: 3, end: 16 }))._ok);
  await freshTurn(sectionSpec());
  assert.ok((await exec('insert_after_line', { line: 4, text: 'New.' }))._ok);
  assert.ok((await exec('format_lines', { start: 4, end: 5, align: 'center' }))._ok);
  await fresh(sectionSpec()); // the panel's own calls and the self-test: no snap.readFirst
  assert.ok((await exec('delete_lines', { start: 4, end: 5 }))._ok);
  // unit: tools outside the list, a missing plan
  assert.strictEqual(T.readFirstCheck('replace_text', { region: [1, 3] }, {}, { readFirst: true, docText: 'a\nb\nc' }), null);
  assert.strictEqual(T.readFirstCheck('delete_lines', null, {}, { readFirst: true, docText: 'a' }), null);
  // reads of an opened document do not count for the main one
  const snap = { readFirst: true, docText: 'a\nb\nc' };
  T.noteSeenLines('read_lines', { start: 1, end: 3, doc: 'doc2' }, { _ok: true, content: 'Lines 1-3 of 3:\n1: a\n2: b\n3: c' }, snap);
  assert.strictEqual(snap.seenLines, undefined);
  T.noteSeenLines('read_lines', { start: 1, end: 3 }, { _ok: true, content: 'Lines 1-3 of 3:\n1: a\n2 [r1c1]: b\n3: c' }, snap);
  deq([...snap.seenLines].sort(), [1, 2, 3]);
});

test('in a full turn: the model gets the refusal with the text, calls again, and the delete is applied', async () => {
  fake = fakeDocsServer(sectionSpec());
  fake.token = ident.token = 'tok-1'; ident.granted = true;
  state.googleConnected = true; state.applyMode = 'auto'; state.settings.provider = 'anthropic';
  Object.assign(state.settings.providers.anthropic, { apiKey: 'sk-ant-X', model: 'claude-opus-5-5' });
  const bodies = [];
  const rounds = [
    msgStart + tu(0, 'toolu_d1', 'delete_lines', { start: 4, end: 5 }) + stopTool,
    msgStart + tu(0, 'toolu_d2', 'delete_lines', { start: 4, end: 5 }) + stopTool,
    textRound('Deleted.'),
  ];
  sandbox.fetch = routeDocs(async (url, init) => { bodies.push(JSON.parse(init.body)); return sseResponse(rounds[bodies.length - 1]); });
  chrome.tabs.sendMessage = async (id, msg) => (msg.type === 'GET_SELECTION' ? { ok: true, text: '' } : { ok: true, title: 'My Doc', text: '' });
  await T.createChat();
  T.el.input.value = 'Delete lines 4 and 5';
  await T.sendMessage();
  assert.strictEqual(bodies.length, 3);
  const refusal = bodies[1].messages[bodies[1].messages.length - 1].content[0];
  assert.strictEqual(refusal.type, 'tool_result');
  assert.ok(refusal.content.startsWith(`${REFUSED} lines 4–5 in this message. They currently say:\n4: Method line 4.`), refusal.content);
  assert.ok(!fake.text('t.0').includes('Method line 4.'));
});
