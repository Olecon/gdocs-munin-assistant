'use strict';
// Guards against a weak model's loops: every beforeWrite check in one round, the repeat guard over refusals, line
// numbers of registered writing tools after a write in the same response (spec.usesLines), a denied edit sent again,
// identical reads of an unchanged document, tool arguments that do not parse.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, waitFor, load, installDocTab, installIdentity } = require('./lib/sandbox');
const { docsBench } = require('./lib/fake-docs');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, ident, fresh, exec;
const posts = () => fake.log.filter((x) => x.method === 'POST').length;
const call = (name, args, raw) => ({ id: 'c_' + Math.random().toString(36).slice(2, 7), type: 'function', function: { name, arguments: raw != null ? raw : JSON.stringify(args) } });

before(async () => {
  env = await load();
  T = env.T;
  state = env.state;
  ident = installIdentity(env);
  ({ fresh, exec } = docsBench(env, ident, ref));
  installDocTab(env);
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic'; state.googleConnected = true;
  // Two test checks: one remembers its refusal (as the built-in checks do), one refuses every time (an agent's scope).
  const once = new Set();
  T.registerTurnHook('beforeWrite', (name, plan, args) => {
    if (!String(args.new_text || '').includes('[once]')) return null;
    const key = JSON.stringify(args);
    if (once.has(key)) return { notes: ['passed the once check.'] };
    once.add(key);
    return { refuse: 'the once check refuses.' };
  });
  T.registerTurnHook('beforeWrite', (name, plan, args) => (String(args.new_text || '').includes('[always]') ? { refuse: 'the always check refuses.' } : null));
});

test('beforeWrite: every check runs, their refusals come in one result; the remembered one passes on the retry', async () => {
  await fresh();
  const args = { old_text: 'Intro', new_text: 'Intro [once] [always]', line: null };
  let r = await exec('replace_text', args);
  deq([r._ok, r._message, r.content], [false, 'Refused by a check', 'Refused by a check:\n- the once check refuses.\n- the always check refuses.']);
  r = await exec('replace_text', args); // the once check remembers it; the other still refuses (alone: one line)
  assert.strictEqual(r.content, 'Refused by a check: the always check refuses.');
  assert.strictEqual(posts(), 0);
  const solo = { old_text: 'Intro', new_text: 'Intro [once]', line: null };
  assert.strictEqual((await exec('replace_text', solo)).content, 'Refused by a check: the once check refuses.');
  r = await exec('replace_text', solo);
  assert.ok(r._ok && r.content.endsWith('\nNote: passed the once check.'), r.content);
});

test('repeat guard: the first refusal is not a failure, the same refusal again is', () => {
  const snap = {};
  const tc = call('replace_text', { old_text: 'a', new_text: 'b' });
  const refusal = () => ({ _ok: false, content: 'Refused by a check: the always check refuses.' });
  assert.strictEqual(T.noteRepeatFailure(snap, tc, refusal()), 0);
  assert.strictEqual(T.noteRepeatFailure(snap, tc, refusal()), 1);
  const third = refusal();
  assert.strictEqual(T.noteRepeatFailure(snap, tc, third), 2);
  assert.ok(third.content.endsWith(T.REPEAT_FAIL_NOTE));
  assert.strictEqual(T.noteRepeatFailure(snap, call('replace_text', { old_text: 'a', new_text: 'c' }), refusal()), 0); // other arguments
});

test('usesLines: page_parts and comment with line numbers are refused after a write in the same response', async () => {
  await fresh();
  assert.ok(T.extraUsesLines('page_parts', { action: 'section_break', line: 4 }));
  assert.ok(T.extraUsesLines('page_parts', { action: 'section_style', line: 4, number: null }));
  assert.ok(!T.extraUsesLines('page_parts', { action: 'section_style', line: 4, number: 2 }));
  assert.ok(!T.extraUsesLines('page_parts', { action: 'set_text', part: 'header', text: 'H' }));
  assert.ok(T.extraUsesLines('comment', { action: 'add', lines: '4', old_text: null, text: 'Why?' }));
  assert.ok(!T.extraUsesLines('comment', { action: 'add', lines: '4', old_text: 'Alpha', text: 'Why?' }));
  assert.ok(!T.extraUsesLines('comment', { action: 'resolve', ids: ['c1'] }));
  assert.ok(!T.extraUsesLines('replace_text', { line: 3 })); // built-in tools keep their own check
  assert.ok((await exec('replace_text', { old_text: 'Intro', new_text: 'Preface', line: null }))._ok);
  const before = posts();
  const brk = await exec('page_parts', { action: 'section_break', part: null, number: null, text: null, after_text: null, line: 4, type: null }, 'p1', true);
  assert.ok(!brk._ok && brk.content.startsWith('Error: line numbers changed after the previous edit in this response (or the document was re-read because it changed), so this page_parts call was not applied; re-read with read_document and call it again with the current numbers.\nThe text around the previous edit now reads:\n'), brk.content);
  assert.strictEqual(brk._message, 'page_parts: line numbers changed by the previous edit; not applied');
  as.commentOffer = true;
  const add = await exec('comment', { action: 'add', ids: null, text: 'Why?', old_text: null, lines: '4', assignee: null }, 'c1', true);
  assert.ok(!add._ok && add.content.includes('so this comment call was not applied'), add.content);
  assert.strictEqual(posts(), before);
  // in the next response the numbers are current again
  const ok = await exec('page_parts', { action: 'section_break', part: null, number: null, text: null, after_text: null, line: 4, type: null }, 'p2');
  assert.ok(ok._ok, ok.content);
});

test('a denied edit sent again in the same turn: the denial without a card, counted by the repeat guard', async () => {
  await fresh();
  as.askEdits = true; // Manual: every edit asks
  const args = { old_text: 'Intro', new_text: 'Preface', line: null };
  const p = exec('replace_text', args, 'd1');
  await waitFor(() => T.pendingPreviews.size === 1, 'the gate card');
  const [[id]] = [...T.pendingPreviews.entries()];
  T.decidePreview(id, 'reject');
  const first = await p;
  deq([first._ok, first.content], [false, T.EDIT_DENIED_TEXT]);
  const tc = call('replace_text', args);
  const again = await T.executeTool(tc, 'edit', as);
  assert.strictEqual(T.pendingPreviews.size, 0);
  deq([again._ok, again.content, again._message], [false, 'Error: ' + T.EDIT_DENIED_TEXT, 'Edit not allowed']);
  assert.strictEqual(T.noteRepeatFailure(as, tc, again), 1);
  assert.strictEqual(posts(), 0);
  // other arguments ask again
  const other = exec('replace_text', { old_text: 'Intro', new_text: 'Foreword', line: null }, 'd2');
  await waitFor(() => T.pendingPreviews.size === 1, 'the second card');
  T.decidePreview([...T.pendingPreviews.keys()][0], 'reject');
  assert.strictEqual((await other).content, T.EDIT_DENIED_TEXT);
  // a new turn asks again
  as = T.takeSnapshot(); T.snapshotDocument(as); as.askEdits = true;
  const next = exec('replace_text', args, 'd3');
  await waitFor(() => T.pendingPreviews.size === 1, 'the card of the next turn');
  T.decidePreview([...T.pendingPreviews.keys()][0], 'accept');
  assert.ok((await next)._ok);
});

test('an identical read of an unchanged document: a pointer on every repeat, firmer from the second; a write changes the key', async () => {
  await fresh();
  const args = { scope: { start: 2, end: 4 }, include: ['text'], doc: null };
  const read = () => T.executeTool(call('read_document', args), 'edit', as);
  // only the model's calls of a visible main-chat turn (toolLoop sets readFirst)
  assert.ok((await read()).content.includes('2: Intro'));
  assert.ok((await read()).content.includes('2: Intro'));
  as.readFirst = true;
  const first = await read();
  assert.ok(first._ok && first.content.includes('2: Intro') && first._again === undefined, first.content);
  const again = await read();
  deq([again._ok, again._reading, again.content, again._again], [true, true, T.READ_AGAIN_TEXT, 1]);
  assert.strictEqual(again.content, 'Already read in this message; the document has not changed since: see the earlier result.');
  // the saved chat alternated full results and pointers here until the round budget ran out: no full result again
  const third = await read();
  deq([third._ok, third.content, third._again], [true, T.READ_AGAIN_STOP_TEXT, 2]);
  assert.strictEqual(T.READ_AGAIN_STOP_TEXT, 'You already have this result; the document has not changed. Do not read it again: go on with the task or answer the user.');
  deq([(await read())._again, T.READ_LOOP_REPEATS], [3, 3]); // the one that ends the rounds (toolLoop)
  const other = await T.executeTool(call('read_document', { ...args, scope: { start: 2, end: 5 } }), 'edit', as);
  assert.ok(other.content.includes('2: Intro'));
  assert.ok((await exec('replace_text', { old_text: 'Intro', new_text: 'Preface', line: null }))._ok);
  const after = await read();
  assert.ok(after.content.includes('2: Preface'), after.content);
  // the export path keys on the text's length
  const s = { docFormat: 'export', docText: 'abc', model: null };
  T.noteRead('find_in_document', { query: 'a' }, s);
  deq(T.readAgain('find_in_document', { query: 'a' }, s), { text: T.READ_AGAIN_TEXT, repeats: 1 });
  deq(T.readAgain('find_in_document', { query: 'a' }, s), { text: T.READ_AGAIN_STOP_TEXT, repeats: 2 });
  s.docText = 'abcd';
  assert.strictEqual(T.readAgain('find_in_document', { query: 'a' }, s), null);
  // a pointer given before any call (the selection in the user message) answers the first repeat; then the firm text
  T.noteRead('get_selection', {}, s, 'In the user message.');
  deq([T.readAgain('get_selection', {}, s).text, T.readAgain('get_selection', {}, s).text], ['In the user message.', T.READ_AGAIN_STOP_TEXT]);
});

test('an identical read whose result the request carries only as a stub reads again in full, once', async () => {
  await fresh();
  as.readFirst = true;
  const tc = call('read_document', { scope: { start: 2, end: 4 }, include: ['text'], doc: null });
  const read = () => T.executeTool({ ...tc, id: 'c_' + Math.random().toString(36).slice(2, 7) }, 'edit', as);
  assert.ok((await T.executeTool(tc, 'edit', as)).content.includes('2: Intro'));
  assert.strictEqual((await read()).content, T.READ_AGAIN_TEXT);
  // a request with another result stubbed: nothing changes; with this one stubbed: the next identical call reads
  T.forgetStubbedReads(as, [{ role: 'tool', tool_call_id: 'other', content: '[stub]', _omittedChars: 900 }]);
  assert.strictEqual((await read()).content, T.READ_AGAIN_STOP_TEXT);
  T.forgetStubbedReads(as, [{ role: 'tool', tool_call_id: tc.id, content: '[stub]', _omittedChars: 900 }]);
  const full = await read();
  assert.ok(full.content.includes('2: Intro') && full._again === undefined, full.content);
  assert.strictEqual((await read()).content, T.READ_AGAIN_TEXT);
});

test('tool arguments: double-encoded, fenced and trailing commas are repaired; the error names the tool and its fields', async () => {
  const p = (raw) => { const r = T.parseToolArgs(call('x', null, raw)); return [JSON.stringify(r.args), r.error, !!r.repaired]; };
  deq(p('{"a":1}'), ['{"a":1}', null, false]);
  deq(p(JSON.stringify(JSON.stringify({ a: 1 }))), ['{"a":1}', null, true]);
  deq(p('```json\n{"a": [1, 2,],}\n```'), ['{"a":[1,2]}', null, true]);
  deq(p('{"a": 1,}'), ['{"a":1}', null, true]);
  deq(p(''), ['{}', null, false]);
  deq(p('null'), ['{}', null, false]);
  deq(p('[1]'), ['{}', '[1]', false]);
  deq(p('"just text"'), ['{}', '"just text"', false]);
  deq(p('{"a": '), ['{}', '{"a": ', false]);
  await fresh();
  const bad = await T.executeTool(call('replace_text', null, '{"old_text": "Intro", '), 'edit', as);
  deq([bad._ok, bad.content], [false, 'Error: the arguments of replace_text are not a valid JSON object. Send one JSON object with the fields old_text, new_text, line.']);
  // a repaired call runs, and the history keeps clean JSON (servers parse it)
  const tc = call('replace_text', null, JSON.stringify(JSON.stringify({ old_text: 'Intro', new_text: 'Preface', line: null })));
  const r = await T.executeTool(tc, 'edit', as);
  assert.ok(r._ok, r.content);
  assert.strictEqual(tc.function.arguments, '{"old_text":"Intro","new_text":"Preface","line":null}');
});
