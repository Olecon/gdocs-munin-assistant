'use strict';
// History folding, the first compaction stage: the old turns become one message (user texts, final answers,
// one line per tool call, errors kept) without a request; the summary request runs only when that is not
// enough. Covers the fold text, the budget math, Munin and a cached provider, storage and undo after a fold.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, installIdentity } = require('./lib/sandbox');
const { ORIGINAL, docsBench } = require('./lib/fake-docs');
const { textRound } = require('./lib/streams');
const { docBench, recordFetch, useProvider, send, muText } = require('./lib/context');

let env, T, state, PROVIDERS;
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
const noFetch = async (url) => { throw new Error('unexpected request ' + url); };

before(async () => {
  env = await load();
  T = env.T;
  state = env.state;
  PROVIDERS = env.PROVIDERS;
  docBench(env);
  await T.refreshContext({ force: true });
});

// A finished turn with one successful edit call whose result is long (edit results are not slimmed).
const editTurn = (n, size) => [
  { role: 'user', content: `Question ${n}` },
  { role: 'assistant', content: null, tool_calls: [call(`e${n}`, 'replace_text', { old_text: `old ${n}`, new_text: `new ${n}` })] },
  { role: 'tool', tool_call_id: `e${n}`, content: `Done: replaced line ${n}.\n` + 'q'.repeat(size), _ok: true },
  { role: 'assistant', content: `Answer ${n}.` },
];
const snapNow = () => { const s = T.takeSnapshot(); T.snapshotDocument(s); return s; };
// Base request size in characters (prompt and tools) of a history with one short message.
function baseChars(mode = 'edit') {
  const saved = state.messages;
  state.messages = [{ role: 'user', content: 'x' }];
  const fit = T.fitMessages(mode, snapNow());
  state.messages = saved;
  return T.estimateTokens(fit.messages, JSON.stringify(fit.tools).length) * 3;
}
const ctxOf = () => ({ docId: state.docId, chatId: state.chatId, messages: state.messages });

test('fold text: user texts, one line per call, errors kept and cut, final answers only, no turn context', () => {
  const longErr = 'Error: line 999 does not exist;\nthe document has 80 lines. ' + 'z'.repeat(600);
  const msgs = [
    { role: 'user', content: `${T.SUMMARY_PREFIX}\nOlder summary.`, _summary: true, _covers: 4 },
    { role: 'user', content: 'Fix the typos', _context: '<document title="D">\nOutline\n</document>' },
    { role: 'assistant', content: 'Let me read first.', tool_calls: [call('r1', 'read_lines', { start: 10, end: 60, doc: null })] },
    { role: 'tool', tool_call_id: 'r1', content: '[read_lines 10–60: content omitted after the turn; re-read if needed]', _ok: true, _reading: true },
    { role: 'assistant', content: null, tool_calls: [call('e1', 'replace_text', { old_text: 'Teh ' + 'x'.repeat(100), new_text: 'The' }), call('e2', 'insert_after_line', { line: 999, text: 'New' })] },
    { role: 'tool', tool_call_id: 'e1', content: 'Done: replaced.\n[Later the user undid this edit with the Undo button.]', _ok: true, _edit: { id: 'e1', undone: true } },
    { role: 'tool', tool_call_id: 'e2', content: longErr, _ok: false },
    { role: 'assistant', content: 'Fixed the typo; line 999 does not exist.' },
    { role: 'user', content: 'Open the other doc and format' },
    { role: 'assistant', content: null, tool_calls: [call('o1', 'open_document', { url: 'https://x' }), call('b1', 'get_outline', '{bad'),
      call('f1', 'format_text', { old_text: 'lazy dog', bold: true, italic: true, font: 'Courier New', size: 14, color: '#FF0000', highlight: '#FFFF00', link: 'https://example.com/a/long/path' })] },
    { role: 'tool', tool_call_id: 'o1', content: 'The user did not allow opening this document.', _ok: false, _decision: 'rejected' },
    { role: 'tool', tool_call_id: 'b1', content: 'Error: the arguments are not valid JSON.', _ok: false },
    { role: 'tool', tool_call_id: 'f1', content: 'Done: formatted «lazy dog».', _ok: true },
    { role: 'assistant', content: 'Not opened.' },
  ];
  const lines = T.foldText(msgs).split('\n');
  const err = longErr.replace(/\s+/g, ' ');
  const fmtArgs = 'old_text="lazy dog", bold=true, italic=true, font="Courier New", size=14, color="#FF0000", highlight="#FFFF00", link="https://example.com/a/long/path"';
  deq(lines, [
    'Summary of an even earlier part: Older summary.',
    'User: Fix the typos', // the turn context is left out
    '[read_lines(start=10, end=60): ok]', // doc: null left out; "Let me read first." (not the final answer) left out
    `[replace_text(old_text="Teh ${'x'.repeat(34)}…, new_text="The"): ok, undone later]`, // each value cut to 40
    `[insert_after_line(line=999, text="New"): ${err.slice(0, 499)}…]`, // the error kept, on one line, cut to 500
    'Assistant: Fixed the typo; line 999 does not exist.',
    'User: Open the other doc and format',
    '[open_document(url="https://x"): failed: The user did not allow opening this document.]',
    '[get_outline({bad): Error: the arguments are not valid JSON.]', // unparsable arguments as sent
    `[format_text(${fmtArgs.slice(0, 99)}…): ok]`, // all arguments cut to 100
    'Assistant: Not opened.',
  ]);
  assert.ok(!T.foldText(msgs).includes('Outline') && !T.foldText(msgs).includes('qqq'));
  // the entry: a summary message marked _folded; a later fold keeps an earlier fold's lines as they are
  const entry = T.foldEntry(msgs);
  deq(Object.keys(entry).sort(), ['_covers', '_folded', '_summary', 'content', 'role']);
  assert.strictEqual(entry.content, `${T.SUMMARY_PREFIX}\n${T.FOLD_NOTE}\n\n${lines.join('\n')}`);
  assert.strictEqual(entry._covers, 14);
  const again = T.foldText([entry, { role: 'user', content: 'Next' }, { role: 'assistant', content: 'Sure.' }]);
  assert.strictEqual(again, `${lines.join('\n')}\nUser: Next\nAssistant: Sure.`);
  // the summary transcript of a later LLM compaction shows a fold without its note
  assert.ok(!T.compactionTranscript([entry], 'edit', snapNow()).includes(T.FOLD_NOTE));
});

test('an automatic continuation (_auto) is a neutral note in the fold and the summary transcript, not the user\'s words', () => {
  const msgs = [
    { role: 'user', content: 'List the sections' },
    { role: 'assistant', content: 'Part one', tool_calls: [call('r1', 'read_lines', { start: 1, end: 9 })] },
    { role: 'tool', tool_call_id: 'r1', content: 'lines', _ok: true },
    { role: 'user', content: T.AUTO_CONTINUE_TEXT, _auto: true },
    { role: 'assistant', content: 'Part two.' },
    { role: 'user', content: 'Thanks' },
    { role: 'assistant', content: 'You are welcome.' },
  ];
  const note = '[The reply was cut by the length limit and continued.]';
  deq(T.foldText(msgs).split('\n'), ['User: List the sections', '[read_lines(start=1, end=9): ok]', note,
    'Assistant: Part two.', 'User: Thanks', 'Assistant: You are welcome.']);
  const tr = T.compactionTranscript(msgs, 'edit', snapNow());
  assert.ok(tr.includes(note) && !tr.includes(T.AUTO_CONTINUE_TEXT) && !tr.includes('User: [Your reply'), tr);
});

// The history of the fold scenarios: three turns with long edit results, one short turn, the new message.
// The results are sized so that the request is over the budget, while the fold of the old turns fits.
function foldableHistory(mode = 'edit') {
  const over = 8000 * 3 - baseChars(mode) + 6000; // ~2,000 tokens over the 8,000-token floor
  const size = Math.ceil(over / 3);
  return [...editTurn(1, size), ...editTurn(2, size), ...editTurn(3, size),
    { role: 'user', content: 'fourth question' }, { role: 'assistant', content: 'fourth answer' }];
}

for (const prov of ['anthropic', 'munin']) {
  test(`${prov}: the fold replaces the old turns without a request and the turn fits again`, async () => {
    useProvider(env, prov);
    await T.createChat();
    const saved = PROVIDERS[prov].contextTokens;
    PROVIDERS[prov].contextTokens = 100; // the 8,000-token floor
    try {
      state.messages.push(...foldableHistory());
      await T.saveHistory();
      // the budget math, measured on the request the turn would send
      state.messages.push({ role: 'user', content: 'new question' });
      const snap = snapNow();
      const budget = T.compactionBudget('edit', snap);
      const beforeTokens = T.requestTokens('edit', snap, T.activeHistory(state.messages));
      assert.ok(beforeTokens > budget, `${beforeTokens} > ${budget}`);
      const planned = T.compactionPlan('edit', snap);
      assert.ok(planned && planned.length >= 4);
      const fold = T.foldPlan('edit', snap, planned);
      assert.ok(fold && fold.msgs.length >= planned.length && fold.msgs.length % 4 === 0); // whole turns
      const afterTokens = T.requestTokens('edit', snap, [fold.entry, ...T.activeHistory(state.messages).slice(fold.msgs.length)]);
      assert.ok(afterTokens <= budget - T.FOLD_HEADROOM_TOKENS && beforeTokens - afterTokens > 3000, `${afterTokens} vs ${beforeTokens}`);
      state.messages.pop();
      await T.saveHistory();
      // the turn: one request (the answer), no summary request
      const bodies = recordFetch(env, [prov === 'munin' ? muText('Done.') : textRound('Done.')]);
      await send(env, 'new question');
      assert.strictEqual(bodies.length, 1);
      const ch = state.messages;
      const entry = ch.find((m) => m._folded);
      assert.ok(entry && entry._summary && entry.content.startsWith(`${T.SUMMARY_PREFIX}\n${T.FOLD_NOTE}\n\nUser: Question 1\n[replace_text(old_text="old 1", new_text="new 1"): ok]\nAssistant: Answer 1.`));
      assert.strictEqual(ch.indexOf(entry), entry._covers);
      assert.ok(ch.slice(0, entry._covers).every((m) => m._compacted));
      assert.ok(!ch.slice(entry._covers + 1).some((m) => m._compacted));
      // the request: the fold first, then the kept turns; no long result of a folded turn
      const sent = JSON.stringify(bodies[0].messages);
      for (const m of ch.slice(0, entry._covers)) if (m.role === 'tool') assert.ok(!sent.includes(m.content.slice(0, 30)));
      if (prov === 'munin') {
        deq(bodies[0].messages[1], { role: 'user', content: entry.content });
        assert.ok(!bodies[0].messages.some((m) => m.content === T.COMPACT_PROMPT));
      } else {
        assert.strictEqual(bodies[0].messages[0].content[0].text, entry.content);
        assert.notStrictEqual(bodies[0].system, T.COMPACT_PROMPT);
      }
      // folded tool results are cut like after a summary; stored; survives normalizeHistory unchanged
      const tool1 = ch.find((m) => m.tool_call_id === 'e1');
      assert.ok(tool1._compacted && tool1.content.endsWith(T.COMPACTED_TOOL_MARKER) && tool1.content.length === 1000 + T.COMPACTED_TOOL_MARKER.length);
      const stored = env.storage[`muninChatHistory:DOC123:${state.chatId}`];
      deq(JSON.parse(JSON.stringify(stored)).map((m) => [m.role, !!m._compacted, !!m._folded]), ch.map((m) => [m.role, !!m._compacted, !!m._folded]));
      deq(T.normalizeHistory(JSON.parse(JSON.stringify(stored))), JSON.parse(JSON.stringify(stored)));
      // the next turn fits without another compaction
      const next = recordFetch(env, [prov === 'munin' ? muText('OK.') : textRound('OK.')]);
      await send(env, 'short follow-up');
      assert.strictEqual(next.length, 1);
      assert.strictEqual(ch.filter((m) => m._summary).length, 1);
    } finally {
      PROVIDERS[prov].contextTokens = saved;
    }
  });
}

test('folding is not enough: the summary request runs on the original messages', async () => {
  useProvider(env, 'anthropic');
  await T.createChat();
  const saved = PROVIDERS.anthropic.contextTokens;
  PROVIDERS.anthropic.contextTokens = 100;
  try {
    // long user texts and answers: a fold keeps them whole, so it cannot fit
    const A = 'a'.repeat(9000);
    state.messages.push(
      { role: 'user', content: 'First: ' + A }, { role: 'assistant', content: null, tool_calls: [call('s1', 'replace_text', { old_text: 'a', new_text: 'b' })] },
      { role: 'tool', tool_call_id: 's1', content: 'Done: replaced line 3.', _ok: true }, { role: 'assistant', content: 'B'.repeat(9000) },
      { role: 'user', content: 'Second: ' + A }, { role: 'assistant', content: 'E'.repeat(9000) },
      { role: 'user', content: 'third question' }, { role: 'assistant', content: 'third answer' });
    await T.saveHistory();
    state.messages.push({ role: 'user', content: 'new question' });
    const snap = snapNow();
    assert.strictEqual(T.foldPlan('edit', snap, T.compactionPlan('edit', snap)), null);
    state.messages.pop();
    const bodies = recordFetch(env, [textRound('The user edits a paper.'), textRound('Answer.')]);
    await send(env, 'new question');
    assert.strictEqual(bodies.length, 2);
    assert.strictEqual(bodies[0].system, T.COMPACT_PROMPT);
    // the transcript of the original messages: a successful result the fold would have left out
    assert.ok(bodies[0].messages[0].content.includes('Assistant called replace_text({"old_text":"a","new_text":"b"})\n\nTool result: Done: replaced line 3.'));
    const entry = state.messages.find((m) => m._summary);
    assert.ok(entry && !entry._folded && entry.content.endsWith('The user edits a paper.'));
  } finally {
    PROVIDERS.anthropic.contextTokens = saved;
  }
});

test('after a failed summary request folding still runs (it needs no request)', async () => {
  useProvider(env, 'munin');
  await T.createChat();
  const saved = PROVIDERS.munin.contextTokens;
  PROVIDERS.munin.contextTokens = 100;
  try {
    state.compactionFailedChat = state.chatId;
    state.messages.push(...foldableHistory(), { role: 'user', content: 'new question' });
    env.ctx.fetch = noFetch;
    assert.strictEqual(await T.maybeCompact('edit', snapNow(), { aborted: false }, ctxOf()), true);
    assert.ok(state.messages.some((m) => m._folded));
  } finally {
    PROVIDERS.munin.contextTokens = saved;
    state.compactionFailedChat = null;
  }
});

test('undo after a fold: the folded edit keeps its journal and is undone, also after a reload', async () => {
  const denv = await load();
  const ident = installIdentity(denv);
  const ref = { fake: null, as: null };
  const { fresh, exec } = docsBench(denv, ident, ref);
  installDocTab(denv);
  await denv.T.refreshContext({ force: true });
  const DT = denv.T;
  const ds = denv.state;
  ds.settings.provider = 'anthropic'; ds.googleConnected = true;
  Object.assign(ds.settings.providers.anthropic, { apiKey: 'sk-ant-T' });
  await fresh();
  await DT.createChat();
  const saved = denv.PROVIDERS.anthropic.contextTokens;
  try {
    // a real edit through the fake Docs API, in the oldest turn
    const edit = await exec('replace_text', { old_text: 'Last line', new_text: 'Final line' }, 'u1');
    assert.ok(edit._ok && edit._edit);
    assert.ok(ref.fake.text('t.0').includes('Final line'));
    const base = (() => {
      ds.messages = [{ role: 'user', content: 'x' }];
      const s = DT.takeSnapshot(); DT.snapshotDocument(s);
      const fit = DT.fitMessages('edit', s);
      return DT.estimateTokens(fit.messages, JSON.stringify(fit.tools).length) * 3;
    })();
    // the Docs API tools are larger than the 8,000-token floor: a trigger 5,000 tokens above the prompt
    const budget = Math.ceil(base / 3) + 5000;
    denv.PROVIDERS.anthropic.contextTokens = 32000 + 2000 + budget;
    const size = Math.ceil((budget * 3 - base + 6000) / 2);
    ds.messages.splice(0, ds.messages.length,
      { role: 'user', content: 'Rename the last line' },
      { role: 'assistant', content: null, tool_calls: [call('u1', 'replace_text', { old_text: 'Last line', new_text: 'Final line' })] },
      edit,
      { role: 'assistant', content: 'Renamed.' },
      ...editTurn(2, size), ...editTurn(3, size),
      { role: 'user', content: 'fourth question' }, { role: 'assistant', content: 'fourth answer' },
      { role: 'user', content: 'new question' });
    const s = DT.takeSnapshot(); DT.snapshotDocument(s);
    const journal = JSON.stringify(edit._edit);
    assert.strictEqual(DT.compactionBudget('edit', s), budget);
    assert.strictEqual(await DT.maybeCompact('edit', s, { aborted: false }, { docId: ds.docId, chatId: ds.chatId, messages: ds.messages }), true);
    const folded = ds.messages.find((m) => m.tool_call_id === 'u1');
    assert.ok(folded._compacted && ds.messages.some((m) => m._folded));
    assert.strictEqual(JSON.stringify(folded._edit), journal); // the journal is untouched
    assert.strictEqual(DT.latestUndoable(), folded);
    // a reload: the stored chat, normalized, is the history again
    ds.messages = DT.normalizeHistory(JSON.parse(JSON.stringify(denv.storage[`muninChatHistory:DOC123:${ds.chatId}`])));
    assert.ok(DT.latestUndoable() && DT.latestUndoable().tool_call_id === 'u1');
    const undo = await exec('undo_last_edit', {}, 'u1u');
    assert.ok(undo._ok, undo.content);
    deq(ref.fake.text('t.0').split('\n'), ORIGINAL);
  } finally {
    denv.PROVIDERS.anthropic.contextTokens = saved;
  }
});
