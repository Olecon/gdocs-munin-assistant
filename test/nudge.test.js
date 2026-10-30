'use strict';
// The nudge (toolLoop, Auto only, once per turn): a short final reply that announces an edit but called no tool gets one
// more round with NUDGE_TEXT (_auto, _autoKind 'nudge'), asking for a tool call where the provider supports the field
// (OpenAI tool_choice "required", Anthropic {type: "any"} without thinking; Munin: the message only). The detection
// (announcesEdit) is narrow: hits in English and Russian, misses for a no-change answer, a long answer, a question back,
// an offer, a negation and the past tense.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load } = require('./lib/sandbox');
const { textRound } = require('./lib/streams');
const { docBench, recordFetch, useProvider, send, muText, oaText } = require('./lib/context');

let env, T, state, doc;

before(async () => {
  env = await load();
  ({ T, state } = env);
  ({ doc } = docBench(env));
  doc.text = '# Notes\n\nFirst.\n\nSecond.';
  doc.selection = 'Second.';
  await T.refreshContext({ force: true });
});

async function fresh(prov, extra = {}) {
  useProvider(env, prov, extra);
  await T.createChat();
  T.el.chat.children.length = 0;
}

test('announcesEdit: announced edits in English and Russian', () => {
  for (const t of ["I'll update the introduction now.", 'Let me edit line 4.', 'I will now replace the heading with a shorter one.',
    "Next, I'm going to delete the duplicate sentence.", 'Сейчас заменю второй абзац.', 'Давайте изменим заголовок.', 'Я обновлю раздел «Методы».']) {
    assert.strictEqual(T.announcesEdit(t), true, t);
  }
});

test('announcesEdit: no-change answers, long answers, questions, offers, negations and the past tense are not announcements', () => {
  const misses = [
    'I checked the section; no change is needed.',
    "I'll update the introduction. " + 'The section reads well overall and the argument holds. '.repeat(8),
    'Should I update the heading as well?',
    "I can rewrite it in a shorter form. Do you want me to replace the paragraph?",
    "If you want, I'll update the second paragraph too.",
    'I will not change the wording of the abstract.',
    'Я исправил опечатку во втором абзаце.',
    'Я не буду менять этот раздел.',
    'Хотите, чтобы я заменю это?',
    '',
  ];
  for (const t of misses) assert.strictEqual(T.announcesEdit(t), false, t);
  assert.ok(misses[1].length >= T.NUDGE_MAX_CHARS);
});

test('Munin, Auto: an announced edit without a call gets one nudge round; no tool_choice field; the request leaves the history', async () => {
  await fresh('munin');
  const bodies = recordFetch(env, [muText("I'll replace the selected sentence."), muText('No change is needed after all.')]);
  await send(env, 'Fix the selection');
  assert.strictEqual(bodies.length, 2);
  const nudge = bodies[1];
  assert.deepStrictEqual(nudge.messages[nudge.messages.length - 1], { role: 'user', content: T.NUDGE_TEXT });
  assert.strictEqual(T.NUDGE_TEXT, 'You announced an action but called no tool. Call the tool now, or say that no change is needed.');
  assert.strictEqual(nudge.tool_choice, undefined);
  assert.ok(nudge.tools && nudge.tools.length, 'the nudge round keeps the tools');
  const h = state.messages;
  deq(h.map((m) => m.content), ['Fix the selection', "I'll replace the selected sentence.", 'No change is needed after all.']);
  assert.ok(!h.some((m) => m._auto));
});

test('once per turn, and never in Manual or for a non-announcement', async () => {
  await fresh('munin');
  let bodies = recordFetch(env, [muText("I'll update the heading."), muText("I'll update the heading."), muText('never')]);
  await send(env, 'Go');
  assert.strictEqual(bodies.length, 2, 'the second announcement ends the turn');
  // the next turn may nudge again
  bodies = recordFetch(env, [muText('Let me edit it.'), muText('Done thinking.')]);
  await send(env, 'Again');
  assert.strictEqual(bodies.length, 2);
  bodies = recordFetch(env, [muText('I checked the section; no change is needed.')]);
  await send(env, 'Check');
  assert.strictEqual(bodies.length, 1);
  state.applyMode = 'manual';
  try {
    bodies = recordFetch(env, [muText("I'll update the heading."), muText('never')]);
    await send(env, 'Manual');
    assert.strictEqual(bodies.length, 1);
  } finally {
    state.applyMode = 'auto';
  }
});

test('OpenAI: the nudge request sets tool_choice "required"; the other requests do not', async () => {
  await fresh('openai');
  const bodies = recordFetch(env, [oaText("I'll rewrite the selection."), oaText('Nothing to change.')]);
  await send(env, 'Rewrite');
  assert.strictEqual(bodies.length, 2);
  assert.strictEqual(bodies[0].tool_choice, undefined);
  assert.strictEqual(bodies[1].tool_choice, 'required');
});

test('Anthropic: tool_choice "any" without thinking; with adaptive thinking the nudge goes without the field', async () => {
  await fresh('anthropic', { model: 'claude-sonnet-4-5' });
  let bodies = recordFetch(env, [textRound("I'll replace the sentence."), textRound('Done.')]);
  await send(env, 'Replace');
  assert.strictEqual(bodies.length, 2);
  assert.strictEqual(bodies[1].thinking, undefined);
  assert.deepStrictEqual(bodies[1].tool_choice, { type: 'any', disable_parallel_tool_use: true });
  await fresh('anthropic', { model: 'claude-opus-5-5' });
  bodies = recordFetch(env, [textRound("I'll replace the sentence."), textRound('Done.')]);
  await send(env, 'Replace');
  assert.strictEqual(bodies.length, 2);
  assert.ok(bodies[1].thinking);
  assert.strictEqual(bodies[1].tool_choice, undefined);
  const last = bodies[1].messages[bodies[1].messages.length - 1];
  assert.strictEqual(last.content[last.content.length - 1].text, T.NUDGE_TEXT);
});
