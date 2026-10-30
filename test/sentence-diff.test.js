'use strict';
// The sentence diff of a changed line (src/doc-history.js: sentenceChanges): document_changes shows a changed line pair
// by its changed sentences, so a one-word fix in a long paragraph costs one short entry; a reordered paragraph gives a
// "moved" entry; whole-line adds and removes stay; Russian abbreviations do not split; the caps still hold; and the
// turn-context line of own-changes.js uses the same rule.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load } = require('./lib/sandbox');

const AT = new Date(2026, 9, 22, 18, 40).getTime();
let T;
before(async () => { T = (await load()).T; });

const entry = (lines) => { const text = lines.join('\n'); return { text, at: AT, format: 'text', tab: '', chars: text.length, lines: lines.length }; };
const changes = (a, b, opts) => T.renderDocChanges(entry(a), b.join('\n'), opts);
const HEAD = 'Changes since 2026-10-22 18:40 (end of the previous session): ';
const LEGEND = ' ("- was N": old line N; "+ N": current line N; "~ N": the changed sentences of line N, «old» → «new».)';
const PARA = 'The lipase was purified by affinity chromatography. Dr. Smith measured its activity at 30 °C. The yield was high in every run. We used PNPB as the substrate.';

test('a one-word change in a four-sentence paragraph: one sentence pair', () => {
  const out = changes(['Title', PARA, 'End'], ['Title', PARA.replace('high', 'low'), 'End']);
  assert.strictEqual(out, `${HEAD}1 line changed; now 3 lines (was 3).${LEGEND}\n… 1 unchanged line …\n~ 2: «The yield was high in every run.» → «The yield was low in every run.»\n… 1 unchanged line …`);
  deq(T.sentenceChanges(PARA, PARA.replace('high', 'low')), [{ t: 'pair', old: 'The yield was high in every run.', new: 'The yield was low in every run.' }]);
});

test('a reordered paragraph: a moved sentence; a sentence added and one removed; a moved line keeps its old number', () => {
  const s = T.splitSentences(PARA);
  deq(T.sentenceChanges(PARA, [s[2], s[0], s[1], s[3]].join(' ')), [{ t: 'moved', new: s[2] }]);
  deq(T.sentenceChanges(PARA, [s[0], s[1], s[3], 'A new closing sentence.'].join(' ')),
    [{ t: 'removed', old: s[2] }, { t: 'added', new: 'A new closing sentence.' }]);
  const out = changes(['A', 'B', PARA], ['B', PARA.replace('PNPB', 'pNPB'), 'C']);
  assert.ok(out.includes('\n~ 2 (was 3): «We used PNPB as the substrate.» → «We used pNPB as the substrate.»'), out);
});

test('added and removed lines stay whole; a line without two sentences or with every sentence changed is a line pair', () => {
  const out = changes(['A', PARA, 'B'], ['A', 'B', 'New line. With two sentences.']);
  assert.ok(out.includes(`\n- was 2: ${PARA}\n`) && out.endsWith('\n+ 3: New line. With two sentences.'), out);
  assert.ok(!out.includes(LEGEND)); // no sentence entries: the legend stays short
  assert.strictEqual(T.sentenceChanges('One sentence here.', 'One sentence there.'), null);
  assert.strictEqual(T.sentenceChanges('First one. Second one.', 'Totally new. Also new.'), null);
  assert.strictEqual(T.sentenceChanges('First one.  Second one.', 'First one. Second one.'), null); // spacing only
  assert.ok(changes(['First one. Second one.'], ['Totally new. Also new.']).endsWith('\n- was 1: First one. Second one.\n+ 1: Totally new. Also new.'));
});

test('Russian abbreviations do not split a sentence', () => {
  const ru = 'Как показано на рис. 3, активность т. е. скорость реакции растёт. Данные см. в табл. 2. Выход составил 40 %.';
  deq(T.sentenceChanges(ru, ru.replace('40 %', '45 %')), [{ t: 'pair', old: 'Выход составил 40 %.', new: 'Выход составил 45 %.' }]);
  deq(T.sentenceChanges(ru, ru.replace('рис. 3', 'рис. 4')),
    [{ t: 'pair', old: 'Как показано на рис. 3, активность т. е. скорость реакции растёт.', new: 'Как показано на рис. 4, активность т. е. скорость реакции растёт.' }]);
});

test('the caps: the line limit counts sentence entries; a long sentence is cut around the change', () => {
  const lines = Array.from({ length: 30 }, (_, i) => `Line ${i} first. Line ${i} second.`);
  const edited = lines.map((l, i) => (i % 2 ? l.replace('second', 'last') : l));
  const capped = changes(lines, edited, { limits: { lines: 4, chars: 10000 } });
  deq(capped.split('\n').slice(1), ['… 1 unchanged line …', ...[1, 3, 5, 7].flatMap((i) => [`~ ${i + 1}: «Line ${i} second.» → «Line ${i} last.»`, '… 1 unchanged line …']).slice(0, 7),
    '[Stopped at current line 10 (limit per call). Call document_changes with lines "10-30" to continue.]']);
  const longS = 'Then ' + 'word '.repeat(150) + 'end.';
  const out = changes([`Short one. ${longS}`], [`Short one. ${longS.replace('word word word', 'word NEW word')}`]);
  assert.ok(/\n~ 1: «Then word word word .*…» → «Then word NEW word .*…»$/.test(out) && out.length < 600, out);
});

test('own-changes: a one-word change in a paragraph is reported by its sentence', () => {
  assert.strictEqual(T.ownChangesLine(`A\n${PARA}`, `A\n${PARA.replace('high', 'low')}`),
    'Since your last message you changed line 2: «The yield was high in every run.» → «The yield was low in every run.».');
  const s = T.splitSentences(PARA);
  assert.strictEqual(T.ownChangesLine(PARA, [s[0], s[1], s[3]].join(' ')), `Since your last message you deleted from line 1: «${s[2]}».`);
  assert.strictEqual(T.ownChangesLine('a\nb', 'a\nB'), 'Since your last message you changed line 2: «b» → «B».');
});
