'use strict';
// The word-level diff of an applied edit (src/word-diff.js): equal texts, insertions, deletions, replacements,
// Cyrillic, punctuation as its own token, the whitespace cleanup, the size limit of the LCS table, and the HTML
// (escaped, capped at WORD_DIFF_SHOW_CHARS characters plus "…").
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ROOT, SCRIPTS } = require('./lib/sandbox');

const ctx = vm.createContext({});
vm.runInContext("function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;'); }", ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/word-diff.js'), 'utf8'), ctx, { filename: 'src/word-diff.js' });
const D = new Proxy({}, { get: (_, name) => vm.runInContext(String(name), ctx) });
const diff = (a, b) => JSON.parse(JSON.stringify(D.wordDiff(a, b)));
// The old and the new text put back together from the ops.
const sides = (ops) => [ops.filter(([op]) => op <= 0).map(([, t]) => t).join(''), ops.filter(([op]) => op >= 0).map(([, t]) => t).join('')];

test('the module is loaded by the panel before render.js', () => {
  const at = SCRIPTS.indexOf('src/word-diff.js');
  assert.ok(at > 0 && at < SCRIPTS.indexOf('src/render.js'));
});

test('equal texts: one kept run; empty sides', () => {
  assert.deepStrictEqual(diff('The cat sat.', 'The cat sat.'), [[0, 'The cat sat.']]);
  assert.deepStrictEqual(diff('', ''), []);
  assert.deepStrictEqual(diff('', 'New text'), [[1, 'New text']]);
  assert.deepStrictEqual(diff('Old text', ''), [[-1, 'Old text']]);
});

test('insert, delete and replace one word', () => {
  assert.deepStrictEqual(diff('The cat sat.', 'The black cat sat.'), [[0, 'The '], [1, 'black '], [0, 'cat sat.']]);
  assert.deepStrictEqual(diff('The black cat sat.', 'The cat sat.'), [[0, 'The '], [-1, 'black '], [0, 'cat sat.']]);
  assert.deepStrictEqual(diff('The cat sat.', 'The dog sat.'), [[0, 'The '], [-1, 'cat'], [1, 'dog'], [0, ' sat.']]);
  // whole words, never parts of them
  assert.deepStrictEqual(diff('cats', 'cars'), [[-1, 'cats'], [1, 'cars']]);
});

test('a space between two changed words goes into both sides', () => {
  assert.deepStrictEqual(diff('We saw a big red fox.', 'We saw a small grey fox.'), [[0, 'We saw a '], [-1, 'big red'], [1, 'small grey'], [0, ' fox.']]);
});

test('Cyrillic words and punctuation tokens', () => {
  assert.deepStrictEqual(diff('Мы измерили спектр.', 'Мы измерили спектры!'), [[0, 'Мы измерили '], [-1, 'спектр.'], [1, 'спектры!']]);
  assert.deepStrictEqual(diff('Hello, world', 'Hello; world'), [[0, 'Hello'], [-1, ','], [1, ';'], [0, ' world']]);
  assert.deepStrictEqual(diff('ёлка', 'ёлка, ель'), [[0, 'ёлка'], [1, ', ель']]);
});

test('the ops always rebuild both texts', () => {
  const pairs = [
    ['A quick brown fox jumps over the lazy dog.', 'The quick red fox leaps over a lazy dog!'],
    ['one two three four five', 'five four three two one'],
    ['Line one\nLine two\n', 'Line one\nLine 2\nLine three\n'],
    ['Таблица 1. Результаты (n = 5).', 'Таблица 2: результаты (n=6)'],
  ];
  for (const [a, b] of pairs) assert.deepStrictEqual(sides(diff(a, b)), [a, b]);
});

test('a middle too large for the table is one deletion and one insertion', () => {
  const a = Array.from({ length: 700 }, (_, i) => `a${i}`).join(' ');
  const b = Array.from({ length: 700 }, (_, i) => `b${i}`).join(' ');
  const ops = diff('Start ' + a + ' end.', 'Start ' + b + ' end.');
  assert.deepStrictEqual(ops.map(([op]) => op), [0, -1, 1, 0]);
  assert.deepStrictEqual(sides(ops), ['Start ' + a + ' end.', 'Start ' + b + ' end.']);
});

test('HTML: del and ins spans, document text escaped, capped with "…"', () => {
  assert.strictEqual(D.wordDiffHtml(D.wordDiff('if a < b', 'if a <= b')), 'if a &lt;<ins>=</ins> b');
  assert.strictEqual(D.wordDiffHtml(D.wordDiff('<b>old</b>', '<b>new</b>')), '&lt;b&gt;<del>old</del><ins>new</ins>&lt;/b&gt;');
  const long = 'word '.repeat(200);
  const html = D.wordDiffHtml(D.wordDiff(long, long + 'tail'));
  assert.strictEqual(D.WORD_DIFF_SHOW_CHARS, 400);
  assert.ok(html.endsWith('…'));
  assert.strictEqual(html.length, 401);
  assert.ok(!D.wordDiffHtml(D.wordDiff('short', 'shorter')).endsWith('…'));
  assert.strictEqual(D.wordDiffHtml(D.wordDiff('abc def', 'abc xyz'), 5), 'abc <del>d</del>…');
});
