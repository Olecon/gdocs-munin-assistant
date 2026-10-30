'use strict';
// What the user changed since this panel's last turn (src/own-changes.js): the line format (changed, added, deleted;
// long lines cut around the change), the caps, and through chat turns: nothing on the first turn or when the text is
// the same, one edited line, a large paste, no line after the model's paste or after another
// panel's turn.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { load } = require('./lib/sandbox');
const { textRound, msgStart, tu, stopTool } = require('./lib/streams');
const { docBench, recordFetch, useProvider, send } = require('./lib/context');

let env, T, state, doc;
const BASE = ['# Paper', '', 'Intro.', '', '## Methods', '', 'We used 5 mg.', '', '## Results', '', 'It worked.'];
const ctx = (i) => state.messages[i]._context || '';
const ownLine = (i) => ctx(i).split('\n').find((l) => l.startsWith('Since your last message') || l.startsWith('You changed about')) || '';

before(async () => {
  env = await load();
  ({ T, state } = env);
  ({ doc } = docBench(env));
  await T.refreshContext({ force: true });
});

test('ownChangesLine: changed, added and deleted lines; equal texts give nothing', () => {
  assert.strictEqual(T.ownChangesLine('a\nb\nc', 'a\nb\nc'), '');
  assert.strictEqual(T.ownChangesLine('a\nb\nc', 'a\nB\nc'), 'Since your last message you changed line 2: «b» → «B».');
  assert.strictEqual(T.ownChangesLine('a\nb\nc\nd', 'a\nX\nY\nc\nd\ne'),
    'Since your last message you changed lines 2–3: «b» → «X / Y»; added line 6: «e».');
  assert.strictEqual(T.ownChangesLine('a\nb\nc\nd', 'a\nd'), 'Since your last message you deleted at line 2: «b / c».');
});

test('ownChangesLine: a long line is cut around the change; more than 5 ranges or about 400 tokens give the count', () => {
  const long = 'Lorem ipsum dolor sit amet, '.repeat(10);
  const line = T.ownChangesLine(`x\n${long}n = 48 participants, ${long}\ny`, `x\n${long}n = 52 participants, ${long}\ny`);
  assert.ok(line.startsWith('Since your last message you changed line 2: «…'), line);
  assert.ok(line.includes('n = 48 participants') && line.includes('n = 52 participants') && line.length < 400, line);
  const many = Array.from({ length: 20 }, (_, i) => `line ${i}`);
  const edited = many.map((l, i) => (i % 3 === 0 ? l + ' edited' : l));
  assert.strictEqual(T.ownChangesLine(many.join('\n'), edited.join('\n')), 'You changed about 7 lines since your last message (too many to list).');
  const big = Array.from({ length: 5 }, (_, i) => `para ${i} ` + 'w'.repeat(400));
  const bigEdited = big.map((l, i) => 'z'.repeat(400) + i);
  // a long block: each side cut to 120 characters
  const m = /^Since your last message you changed lines 2–6: «(para 0 w+…)» → «(z+…)»\.$/.exec(T.ownChangesLine(['a', ...big, 'b'].join('\n'), ['a', ...bigEdited, 'b'].join('\n')));
  assert.ok(m && m[1].length === 120 && m[2].length === 120);
});

test('chat turns: nothing on the first turn or when unchanged; one edited line; a large paste gives only the count', async () => {
  useProvider(env, 'anthropic', { model: 'claude-opus-5-5' });
  T.ownBaselines.clear(); // a new panel: no turn yet
  await T.createChat();
  recordFetch(env, [textRound('OK.')]);
  doc.text = BASE.join('\n'); doc.selection = '';
  await send(env, 'first');
  assert.strictEqual(ownLine(0), '', ctx(0)); // the first turn has nothing to compare with
  await send(env, 'second');
  assert.strictEqual(ownLine(2), ''); // unchanged
  doc.text = BASE.map((l) => (l === 'We used 5 mg.' ? 'We used 10 mg.' : l)).join('\n');
  await send(env, 'third');
  assert.strictEqual(ownLine(4), 'Since your last message you changed line 7: «We used 5 mg.» → «We used 10 mg.».');
  // the line sits after the document block, before the selection line
  assert.ok(/<\/document>\n(?:<document_changes>.*<\/document_changes>\n)?Since your last message/.test(ctx(4)), ctx(4));
  // a pasted page: many scattered changes
  doc.text = BASE.map((l, i) => (l ? `${l} (pasted ${i})` : l)).join('\n');
  await send(env, 'fourth');
  assert.strictEqual(ownLine(6), 'You changed about 6 lines since your last message (too many to list).');
});

test('a turn that pasted, or another panel\'s later turn, leaves no line', async () => {
  useProvider(env, 'anthropic', { model: 'claude-opus-5-5' });
  T.ownBaselines.clear();
  await T.createChat();
  doc.text = BASE.join('\n'); doc.selection = 'It worked.';
  // turn 1 pastes over the selection (export path): the panel cannot read the paste back in this turn
  recordFetch(env, [msgStart + tu(0, 'toolu_p', 'replace_selection', { text: 'It worked well.' }) + stopTool, textRound('Done.')]);
  await send(env, 'improve the selection');
  assert.ok(state.messages.some((m) => m.role === 'tool' && m._ok), JSON.stringify(state.messages.filter((m) => m.role === 'tool')));
  doc.text = BASE.map((l) => (l === 'It worked.' ? 'It worked well.' : l)).join('\n'); doc.selection = '';
  recordFetch(env, [textRound('OK.')]);
  await send(env, 'next');
  assert.strictEqual(ownLine(state.messages.length - 2), ''); // the pasted text is not the user's change
  // now the baseline is this turn's text; another panel of the document finishes a turn later
  await new Promise((r) => setTimeout(r, 20));
  const key = 'muninDocText:DOC123';
  const rec = env.storage[key];
  assert.ok(rec && rec.latest, 'doc-history stored the text');
  env.storage[key] = { ...rec, latest: { ...rec.latest, session: 'other-panel', at: Date.now() + 1000, text: rec.latest.text + '\nX' } };
  doc.text = doc.text + '\nX';
  await send(env, 'after the other tab');
  assert.strictEqual(ownLine(state.messages.length - 2), '');
});
