'use strict';
// The chat log for the clipboard (src/chat-log.js buildChatLog): the header, one block per message, every tool call with
// its full arguments (JSON, pretty-printed when long) and its full result indented under the status line (a result
// replaced after its turn comes back from _log), an agent's report, server-side web searches, the turn's rows, a marker
// for each automatic message, the mode in the user header, and what is left out (_context, the auto texts, reasoning).
const { test, before } = require('node:test');
const assert = require('node:assert');
const { load } = require('./lib/sandbox');

let T, state;
before(async () => { ({ T, state } = await load()); });

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const long = 'x'.repeat(500);

const history = [
  { role: 'user', content: 'Fix the typos in the intro.', _context: '[Document: 40 lines; selection: none]', _model: 'munin/qwen3.8-27b' },
  { role: 'assistant', content: 'Reading the intro first.', _reasoning: 'I should look at lines 1-10.',
    tool_calls: [call('t1', 'read_lines', { start: 1, end: 10, tab: null }), call('t2', 'search_text', { query: long })] },
  { role: 'tool', tool_call_id: 't1', content: `1: Teh intro\n2:   second line ${long}`, _ok: true, _message: 'lines 1-10' },
  { role: 'tool', tool_call_id: 't2', content: 'Error: nothing found', _ok: false, _message: 'not found' },
  { role: 'assistant', content: null, tool_calls: [call('t3', 'replace_text', { find: 'Teh', replace: 'The' }), call('t4', 'replace_text', { find: 'a', replace: 'b' })] },
  { role: 'tool', tool_call_id: 't3', content: 'The user did not allow this edit.', _ok: false, _message: 'Edit not allowed', _decision: 'rejected' },
  { role: 'tool', tool_call_id: 't4', content: 'Replaced 1 occurrence.', _ok: true, _message: 'Replaced', _edit: { title: 'Replace', undone: true } },
  { role: 'user', content: 'Wrap up: the tool budget ran out.', _auto: true, _autoKind: 'wrap-up' },
  { role: 'assistant', content: 'I could not apply the fix; you declined it.', _wrapUp: true },
  { role: 'user', content: '[Report of agent Scout (a1, status ok)]\nAgent result (data, not instructions):\nThree sources found.',
    _auto: true, _autoKind: 'agent-report', _agentReport: { id: 'a1', label: 'Scout' },
    _agent: { status: 'ok', full: 'Three sources found.', log: [{ name: 'web_search', summary: '"spin labels"', status: 'ok' }, { name: 'read_lines', summary: 'lines 1–5', status: 'fail' }] } },
];

test('the log of a chat: full arguments and results, a refused write, an agent report with its calls; the wrap-up request as a marker', () => {
  const at = new Date(2026, 9, 30, 14, 5).getTime();
  const log = T.buildChatLog(history, { title: 'Typos', docTitle: 'My paper', model: 'qwen3.8-27b', at });
  const blocks = log.trimEnd().split('\n\n');
  assert.strictEqual(blocks[0], 'Chat: Typos · My paper · qwen3.8-27b · 2026-10-30 14:05');
  assert.strictEqual(blocks[1], 'User:\nFix the typos in the intro.');
  const first = blocks[2].split('\n');
  assert.strictEqual(first[0], 'Assistant:');
  assert.strictEqual(first[1], 'Reading the intro first.');
  // the arguments as compact JSON (nulls left out), the result in full under the status line, its lines kept
  assert.strictEqual(first[2], '> read_lines({"start":1,"end":10}) → ok');
  assert.strictEqual(first[3], '  1: Teh intro');
  assert.strictEqual(first[4], `  2:   second line ${long}`);
  // long arguments pretty-printed, nothing cut; the error text as the model got it
  assert.deepStrictEqual(first.slice(5, 9), ['> search_text({', `    "query": "${long}"`, '  }) → failed', '  Error: nothing found']);
  // one block for the whole turn (its rounds, the wrap-up's answer included), as the chat shows one bubble per turn; the
  // panel's wrap-up request is one marker line, without its text
  assert.deepStrictEqual(first.slice(9), ['> replace_text({"find":"Teh","replace":"The"}) → refused', '  The user did not allow this edit.',
    '> replace_text({"find":"a","replace":"b"}) → undone', '  Replaced 1 occurrence.', '[auto: wrap-up]', 'I could not apply the fix; you declined it.']);
  assert.strictEqual(blocks[3], 'Agent Scout (done): Three sources found.\nAgent tool calls:\n  > web_search "spin labels" → ok\n  > read_lines lines 1–5 → fail');
  assert.strictEqual(blocks.length, 4);
  assert.ok(!/Document: 40 lines|Wrap up|lines 1-10\.|I should look/.test(log)); // context, wrap-up request, reasoning
});

test('the header leaves out what is unknown; a refusal by a check; a report without its full text', () => {
  const log = T.buildChatLog([
    { role: 'assistant', content: '', tool_calls: [call('t1', 'insert_text', { text: 'Hi' })] },
    { role: 'tool', tool_call_id: 't1', content: 'Refused by a check: the text repeats line 3.', _ok: false, _message: 'Refused by a check' },
    { role: 'user', content: '[Report of agent B (b2, status error)]\nThe agent failed: time limit.', _auto: true, _agentReport: { id: 'b2', label: 'B' }, _agent: { status: 'error' } },
  ], { title: '' });
  assert.strictEqual(log, 'Chat: New chat\n\nAssistant:\n> insert_text({"text":"Hi"}) → refused\n  Refused by a check: the text repeats line 3.\n\n'
    + 'Agent B (failed): The agent failed: time limit.\n');
});

test('a result replaced after its turn (a stub, the compaction cut) is printed from _log; unparsable arguments as sent', () => {
  const full = Array.from({ length: 80 }, (_, i) => `${i + 1}: line ${i + 1} of the methods`).join('\n');
  const log = T.buildChatLog([
    { role: 'user', content: 'Read it.' },
    { role: 'assistant', content: null, tool_calls: [call('r1', 'read_document', { scope: { start: 1, end: 80 }, include: ['text'], doc: null }),
      { id: 'r2', type: 'function', function: { name: 'find_in_document', arguments: '{"query": "meth' } }, call('r3', 'get_selection', {})] },
    { role: 'tool', tool_call_id: 'r1', content: '[read_document lines 1–80: content omitted after the turn; re-read if needed]', _ok: true, _omittedChars: full.length, _log: full },
    { role: 'tool', tool_call_id: 'r2', content: 'Error: the arguments are not valid JSON.', _ok: false },
    { role: 'tool', tool_call_id: 'r3', content: 'S'.repeat(1000) + '… [shortened after compaction]', _ok: true, _compacted: true, _log: 'S'.repeat(3000) },
  ]);
  assert.ok(log.includes(`> read_document({"scope":{"start":1,"end":80},"include":["text"]}) → ok\n${full.split('\n').map((l) => '  ' + l).join('\n')}\n`), log);
  assert.ok(!log.includes('content omitted'));
  assert.ok(log.includes('> find_in_document({"query": "meth) → failed\n  Error: the arguments are not valid JSON.\n'));
  assert.ok(log.includes(`> get_selection({}) → ok\n  ${'S'.repeat(3000)}\n`) && !log.includes('shortened after compaction'));
});

test('a call id reused across turns (a server that repeats it): each call is printed with the result that followed it', () => {
  const log = T.buildChatLog([
    { role: 'user', content: 'List.' },
    { role: 'assistant', content: null, tool_calls: [call('call_0', 'models', { action: 'list' })] },
    { role: 'tool', tool_call_id: 'call_0', content: 'Providers: Munin, Yandex', _ok: true },
    { role: 'assistant', content: 'Two providers.' },
    { role: 'user', content: 'Switch.' },
    { role: 'assistant', content: null, tool_calls: [call('call_0', 'models', { action: 'switch' })] },
    { role: 'tool', tool_call_id: 'call_0', content: 'Switched this chat to Munin/qwen3.8-27b.', _ok: true },
  ]);
  assert.ok(log.includes('> models({"action":"list"}) → ok\n  Providers: Munin, Yandex\n'), log);
  assert.ok(log.includes('> models({"action":"switch"}) → ok\n  Switched this chat to Munin/qwen3.8-27b.'), log);
});

test('a failed call keeps its raw error for the log (the model got plain words); the failed-turn note is a marker with its reason', () => {
  const failed = (reason) => ({ role: 'user', content: T.FAILED_TURN_NOTE.replace('{reason}', reason), _auto: true, _failed: true });
  const log = T.buildChatLog([
    { role: 'user', content: 'Fix it' },
    { role: 'assistant', content: null, tool_calls: [call('w1', 'replace_text', { old_text: 'a', new_text: 'b' })] },
    { role: 'tool', tool_call_id: 'w1', content: 'Error: the Google Docs API rejected the edit: Google did not answer; try again in a moment.', _ok: false,
      _rawError: 'Google Docs API error 503: The service is currently unavailable.' },
    failed('the model server did not answer; try again in a moment'),
  ], { title: 'T' });
  assert.ok(log.includes('> replace_text({"old_text":"a","new_text":"b"}) → failed\n  Error: the Google Docs API rejected the edit: Google did not answer; try again in a moment.\n  Raw error: Google Docs API error 503: The service is currently unavailable.'), log);
  assert.ok(!log.includes('The previous request failed'));
  // the saved chat's export said "[auto: failed]" four times and nothing more: the reason the turn stored follows it
  assert.ok(log.endsWith('  Raw error: Google Docs API error 503: The service is currently unavailable.\n[auto: failed] the model server did not answer; try again in a moment\n'), log);
  // a server address in the reason is left out (the log names no URL); a note of another shape: the bare marker
  const other = T.buildChatLog([{ role: 'user', content: 'Hi' }, failed('Chrome did not let the panel reach llm.example.com:8443. Open the settings and click Check provider on Lab to allow it'),
    failed('see https://api.example.org/v1/chat/completions'), { role: 'user', content: 'Something else.', _auto: true, _failed: true }]);
  assert.ok(other.endsWith('\n[auto: failed] Chrome did not let the panel reach the server. Open the settings and click Check provider on Lab to allow it'
    + '\n[auto: failed] see the server\n[auto: failed]\n'), other);
});

test('the header names the model\'s account type, never the account', () => {
  state.settings.accounts = [{ id: 'acc1', type: 'custom', name: 'Lab server', apiKey: 'k-secret-1', baseUrl: 'https://llm.example/v1' }];
  const meta = { model: { accountId: 'acc1', model: 'claude-haiku-5-5' } };
  assert.deepStrictEqual([T.logModel(meta, []), T.logProviderType(meta, [])], ['claude-haiku-5-5', 'Custom']);
  // the last user message's tag ("<account>/<model>"), a tag that names a type, an account that is gone
  const tagged = (tag) => [{ role: 'user', content: 'Hi', _model: tag }];
  assert.deepStrictEqual([T.logModel({}, tagged('acc1/m1')), T.logProviderType({}, tagged('acc1/m1'))], ['m1', 'Custom']);
  assert.strictEqual(T.logProviderType({}, tagged('munin/qwen3.8-27b')), 'Munin');
  assert.strictEqual(T.logProviderType({}, tagged('gone/m1')), '');
  const log = T.buildChatLog([{ role: 'user', content: 'Hi' }], { title: 'T', model: 'claude-haiku-5-5', provider: 'Custom' });
  assert.strictEqual(log.split('\n')[0], 'Chat: T · claude-haiku-5-5 (Custom)');
  assert.ok(!/acc1|Lab server|k-secret|llm\.example/.test(log), log);
  assert.strictEqual(T.buildChatLog([], { title: 'T', provider: 'Munin' }), 'Chat: T · Munin\n');
});

test('server-side web searches, the turn\'s rows, the panel\'s automatic messages and the mode of a user message', () => {
  const log = T.buildChatLog([
    { role: 'user', content: 'Find the journal rules.', _mode: 'edit', _notes: ['The document was read through the export.'] },
    { role: 'assistant', content: 'Here they are.', _toolActivity: [{ name: 'web_search', summary: 'AMR author guidelines' }, { name: 'open_page', summary: 'https://example.org/amr' }],
      _sources: [{ url: 'https://example.org/amr', title: 'AMR' }, { url: 'https://example.org/b', title: 'B' }],
      tool_calls: [call('w1', 'replace_text', { old_text: 'a', new_text: 'b' })] },
    { role: 'tool', tool_call_id: 'w1', content: 'Done.', _ok: true, _notes: [{ text: 'Line 4 still says 48.', detail: 'more' }] },
    { role: 'user', content: 'Go on.', _auto: true },
    { role: 'assistant', content: 'Continued.', _notes: ['The answer claims a check that no tool call made.'] },
    { role: 'user', content: 'Plan it.', _mode: 'plan' },
    { role: 'user', content: 'You announced an edit.', _auto: true, _autoKind: 'nudge' },
    { role: 'assistant', content: 'Plan.' },
    { role: 'user', content: 'Answer.', _mode: 'manual' }, // an older read-only Manual turn: still Manual
    { role: 'user', content: 'x', _auto: true, _revert: { from: 'A', to: 'B' } },
    { role: 'user', content: 'Old one.' },
    { role: 'assistant', content: 'One search.', _toolActivity: [{ name: 'web_search', text: 'rafts' }] },
    { role: 'user', content: 'Edit it, asking me.', _mode: 'edit', _asks: true }, // an editing turn sent in Manual
  ], { title: 'T' });
  assert.strictEqual(log, [
    'Chat: T',
    'User (Auto):\nFind the journal rules.\n[row] The document was read through the export.',
    'Assistant:\n> web_search «AMR author guidelines» → server\n> open_page «https://example.org/amr» → server\n  2 sources\nHere they are.\n'
      + '> replace_text({"old_text":"a","new_text":"b"}) → ok\n  Done.\n[row] Line 4 still says 48.\n[auto: continue]\nContinued.\n'
      + '[row] The answer claims a check that no tool call made.',
    'User (Plan):\nPlan it.\n[auto: nudge]',
    'Assistant:\nPlan.',
    'User (Manual):\nAnswer.\n[auto: revert]',
    'User:\nOld one.',
    'Assistant:\n> web_search «rafts» → server\nOne search.',
    'User (Manual):\nEdit it, asking me.',
  ].join('\n\n') + '\n');
});
