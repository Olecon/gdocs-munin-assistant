'use strict';
// The Manual-mode output contract: the prompt lines (<replacement> / <insertion>, Manual only), the parser of
// a finished answer (parseEditBlock: one block, several, malformed, Markdown inside, a fenced block), and the
// remember hygiene lines of REMEMBER_NOTE. The rendering and the buttons: test/dom/selection-contract.test.js.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load } = require('./lib/sandbox');

let T, state;
const snap = () => { const s = T.takeSnapshot(); T.snapshotDocument(s); return s; };
const parse = (s) => { const r = T.parseEditBlock(s); return r && JSON.parse(JSON.stringify(r)); };

before(async () => {
  const env = await load();
  ({ T, state } = env);
  state.docFormat = 'markdown'; state.docText = '# Doc\n\nText.'; state.docModel = null; state.selection = '';
});

test('prompt: the tag contract is in the Manual rules only (Auto and persona turns do not get it)', () => {
  const rules = [
    'reply with the COMPLETE resulting text inside <replacement>...</replacement>',
    'When the user asks for new text to add at the cursor ("insert", "add", "write a paragraph"), put it inside <insertion>...</insertion>.',
    'Use at most one such block per answer. Inside it write the document text exactly as it should appear, as plain text:',
    'no markdown (no **, no #, no backticks) unless it is part of the text.',
    'answer normally in the chat without these tags',
  ];
  for (const prov of ['munin', 'openai', 'anthropic']) {
    state.settings.provider = prov;
    const manual = T.buildSystemParts('manual', 100000, snap()).head;
    for (const r of rules) assert.ok(manual.includes(r), `${prov} manual: ${r}`);
    for (const mode of ['edit', 'research', 'chat']) {
      const head = T.buildSystemParts(mode, 100000, snap()).head;
      assert.ok(!head.includes('<replacement>') && !head.includes('<insertion>'), `${prov} ${mode}`);
    }
  }
  state.googleConnected = true; state.docFormat = 'docs-api'; // the Docs API rules of Auto: no tags either
  try {
    state.settings.provider = 'anthropic';
    assert.ok(!T.buildSystemParts('edit', 100000, snap()).head.includes('<replacement>'));
  } finally { state.googleConnected = false; state.docFormat = 'markdown'; }
});

test('prompt: remember hygiene (lasting preferences only, remove a contradicted line, do not mention unasked)', () => {
  const note = T.REMEMBER_NOTE;
  assert.ok(note.includes('Store only lasting preferences, not one-off requests.'));
  assert.ok(note.includes('When a new rule contradicts a line added earlier with remember, remove that line, then add the new rule.'));
  assert.ok(note.includes('Except to confirm a remember call, do not mention the document instructions unless the user asks about them.'));
  assert.ok(note.startsWith('remember(action, text) adds a line to the document instructions or removes one: use it only when the user explicitly asks'));
  assert.strictEqual(note.split('never on your own initiative').length, 2); // the existing guidance is not repeated
});

test('parser: one replacement block, prose around it, the tags on their own lines', () => {
  deq(parse('Here is the fix:\n<replacement>\nThe quick brown fox.\nSecond paragraph.\n</replacement>\nShorter now.'),
    { kind: 'replacement', text: 'The quick brown fox.\nSecond paragraph.', before: 'Here is the fix:\n', after: '\nShorter now.' });
  deq(parse('<insertion>One more sentence.</insertion>'), { kind: 'insertion', text: 'One more sentence.', before: '', after: '' });
  // inline, CRLF, tag case
  deq(parse('Text: <Replacement>a\r\nb</REPLACEMENT>'), { kind: 'replacement', text: 'a\nb', before: 'Text: ', after: '' });
  // leading spaces inside the text are kept; only one newline next to each tag is dropped
  assert.strictEqual(parse('<replacement>\n\n  indented\n\n</replacement>').text, '\n  indented\n');
});

test('parser: Markdown inside the block is verbatim; a block wrapped in a code fence loses the fence', () => {
  assert.strictEqual(parse('<replacement>\n**Bold** # not a heading\n- item\n```\ncode\n```\n</replacement>').text,
    '**Bold** # not a heading\n- item\n```\ncode\n```');
  deq(parse('Result:\n```\n<insertion>\nNew line.\n</insertion>\n```\nDone.'),
    { kind: 'insertion', text: 'New line.', before: 'Result:\n', after: '\nDone.' });
  deq(parse('```text\n<replacement>x</replacement>\n```'), { kind: 'replacement', text: 'x', before: '', after: '' });
});

test('parser: no block, several blocks, malformed or empty blocks give null (rendered as plain text)', () => {
  for (const s of [
    '',
    'Just an answer.',
    '<replacement>a</replacement> and <replacement>b</replacement>',
    '<replacement>a</replacement>\n<insertion>b</insertion>',
    '<replacement>never closed',
    'closed only</replacement>',
    '<replacement>a</insertion>',
    '</replacement>a<replacement>',
    '<replacement>   \n </replacement>',
    '<replacement><insertion>x</insertion></replacement>',
    '<replacement attr="1">x</replacement>',
    // a streaming answer cut inside the block
    'Fix:\n<replacement>\nThe quick',
  ]) assert.strictEqual(T.parseEditBlock(s), null, JSON.stringify(s));
});
