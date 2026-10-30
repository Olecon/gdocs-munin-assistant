'use strict';
// Undo of a format_lines across a table cell: one anchor per group of lines, each group relocated and checked on its
// own; a group whose text changed is not restored, and the refusal names the groups restored and not.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, installIdentity } = require('./lib/sandbox');
const { docSpec, docsBench } = require('./lib/fake-docs');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let T, state, fresh, exec, pushTool, lastPost;

before(async () => {
  const env = await load();
  T = env.T;
  state = env.state;
  const ident = installIdentity(env);
  ({ fresh, exec, pushTool, lastPost } = docsBench(env, ident, ref));
  installDocTab(env);
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic'; state.googleConnected = true;
});

// Lines: 1 a title, 2 Cell A (a one-cell table), 3 After…, 4 Second line, 5 Last.
const spec = () => docSpec({ items: [
  { p: 'A title long enough for context', style: 'TITLE' }, // 20 characters of context before the table
  { table: [[[{ p: 'Cell A' }]]] },
  { p: 'After the table comes a long line' },
  { p: 'Second line' },
  { p: 'Last' },
] });
const NULLS = { style: null, align: null, list: null, indent_start: null, indent_first_line: null, space_above: null, space_below: null, line_spacing: null };
const right = (start, end) => ({ start, end, ...NULLS, align: 'right' });
const range = (s, e) => ({ startIndex: s, endIndex: e, tabId: 't.0' });
const pstyle = (s, e) => ({ updateParagraphStyle: { range: range(s, e), paragraphStyle: {}, fields: 'alignment' } });
const aligns = () => fake.pstyles('t.0').map((p) => p.alignment || null);
// An outside edit inside the body run after the table (fake.typeParagraph only types into the first run).
const typeAfterTable = (i, text) => {
  fake.tabs[0].blocks[2].paras.splice(i, 0, { text, style: 'NORMAL_TEXT', suggest: false, chars: [], pstyle: {}, bullet: null });
  fake.revision++;
};

test('one anchor per group; text typed above both groups: undo relocates and restores each', async () => {
  await fresh(spec());
  const w = pushTool(await exec('format_lines', right(2, 4), 'fl'));
  assert.ok(w._ok, w.content);
  deq(aligns(), [null, 'END', 'END', 'END', null]);
  const g = w._edit.groups;
  deq(g.map((x) => [x.index, x.end, x.text, x.lines]), [[36, 43, 'Cell A', [2, 2]], [43, 89, 'After the table comes a long line\nSecond line', [3, 4]]]);
  deq(g.map((x) => x.anchor.before), [' enough for context\n', ' for context\nCell A\n']);
  deq(g.map((x) => x.requests), [[pstyle(36, 43)], [pstyle(43, 89)]]);
  fake.typeParagraph(0, 'Typed by the user'); // 18 units above both groups
  const u = pushTool(await exec('undo_last_edit', {}));
  assert.ok(u._ok, u.content);
  assert.ok(u.content.startsWith('Done: undid formatting of lines 3–5.'), u.content);
  deq(lastPost().requests, [pstyle(61, 107), pstyle(54, 61)]);
  deq(aligns(), [null, null, null, null, null, null]);
});

test('a group whose text changed is not restored; the others are, and the error names both', async () => {
  await fresh(spec());
  const w = pushTool(await exec('format_lines', right(2, 4), 'fl'));
  assert.ok(w._ok, w.content);
  typeAfterTable(1, 'Typed between'); // inside the second group, beyond the first group's anchor
  const preview = await T.previewUndoAll([w]);
  deq(preview.map((x) => x.status), ['blocked']);
  assert.ok(preview[0].reason.startsWith('only part of that edit would be undone: the formatting of line 2 can be restored, but'), preview[0].reason);
  const u = pushTool(await exec('undo_last_edit', {}));
  assert.strictEqual(u.content, 'Error: only part of that edit was undone: the formatting of line 2 was restored, but the text of lines 3–4 changed after the edit, '
    + 'so that part cannot be restored automatically. Use Undo (Ctrl+Z) in Google Docs instead.');
  deq(lastPost().requests, [pstyle(36, 43)]); // the second group's stale range is not sent
  deq(aligns(), [null, null, 'END', null, 'END', null]);
  assert.strictEqual(w._edit.undone, false); // still undoable: the next undo tries the group that is left
  const posts = fake.log.filter((x) => x.method === 'POST').length;
  const again = pushTool(await exec('undo_last_edit', {}));
  assert.ok(again.content.includes('the formatting of line 2 was restored, but the text of lines 3–4 changed'), again.content);
  assert.strictEqual(fake.log.filter((x) => x.method === 'POST').length, posts); // nothing left to send
});

test('no group found: the usual refusal, nothing sent', async () => {
  await fresh(spec());
  const w = pushTool(await exec('format_lines', right(2, 4), 'fl'));
  const posts = fake.log.filter((x) => x.method === 'POST').length;
  typeAfterTable(0, 'Typed right after the table'); // in both groups' context
  const u = pushTool(await exec('undo_last_edit', {}));
  assert.ok(u.content.startsWith('Error: the document changed near that edit after it was made'), u.content);
  assert.strictEqual(fake.log.filter((x) => x.method === 'POST').length, posts);
  assert.strictEqual(w._edit.undone, false);
});
