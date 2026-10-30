'use strict';
// fitMessages: trimming the oldest messages of an over-budget request keeps every provider's request valid.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { load } = require('./lib/sandbox');

let env, T, state;
before(async () => {
  env = await load();
  T = env.T;
  state = env.state;
});

// The oldest turn: its user message is too long, its tool round small. Dropping only that user message would fit,
// but then the request would start in the middle of a turn: Anthropic drops the leading assistant message and the
// first user message would be an orphaned tool_result (HTTP 400). The whole turn goes instead.
test('trimming drops whole turns: no request starts with an assistant round or an orphaned tool result', () => {
  const PROVIDERS = T.PROVIDERS;
  const saved = PROVIDERS.anthropic.contextTokens;
  PROVIDERS.anthropic.contextTokens = 100; // the 8,000-token floor
  state.settings.provider = 'anthropic';
  state.settings.providers.anthropic.apiKey = 'sk-ant-T';
  const tc = [{ id: 'r1', type: 'function', function: { name: 'get_outline', arguments: '{"doc":null}' } }];
  const tail = [
    { role: 'assistant', content: null, tool_calls: tc }, { role: 'tool', tool_call_id: 'r1', content: 'no headings' },
    { role: 'assistant', content: 'old answer' }, { role: 'user', content: 'go' },
  ];
  state.messages = tail;
  let s = T.takeSnapshot(); T.snapshotDocument(s);
  const fit0 = T.fitMessages('edit', s);
  const baseChars = T.estimateTokens(fit0.messages, JSON.stringify(fit0.tools).length) * 3;
  state.messages = [{ role: 'user', content: 'x'.repeat(8000 * 3 - baseChars + 300) }, ...tail];
  s = T.takeSnapshot(); T.snapshotDocument(s);
  const fit = T.fitMessages('edit', s);
  assert.ok(fit.trimmed);
  assert.deepStrictEqual(fit.history.map((m) => m.content), ['go']);
  const req = T.buildRequest('edit', s);
  assert.strictEqual(req.body.messages[0].role, 'user');
  assert.ok(req.body.messages[0].content.every((b) => b.type === 'text'), 'no tool_result without its tool_use');
  PROVIDERS.anthropic.contextTokens = saved;
});

// fitMessages estimates the request from per-message sizes instead of rebuilding it per dropped turn: the kept
// history is the longest run of whole turns whose built request fits (estimateTokens of the request itself).
test('trimming keeps the most turns that fit, measured on the built request (Munin, shortened old contexts)', () => {
  state.settings.provider = 'munin';
  state.settings.providers.munin.apiKey = 'k-T';
  const ctx = '<document title="x" format="markdown" lines="9" characters="9">\nOutline (line: heading):\nL1: # A\n</document>\nSelection: line 3 (4 characters)';
  const hist = [];
  for (let i = 0; i < 80; i++) {
    const tc = [{ id: 'c' + i, type: 'function', function: { name: 'get_outline', arguments: '{"doc":null}' } }];
    hist.push({ role: 'user', content: `question ${i} ${'q'.repeat(200 + i * 7)}`, _context: ctx },
      { role: 'assistant', content: null, tool_calls: tc }, { role: 'tool', tool_call_id: 'c' + i, content: 'no headings' },
      { role: 'assistant', content: 'answer '.repeat(150 + i) });
  }
  hist.push({ role: 'user', content: 'now', _context: ctx });
  state.messages = hist;
  const s = T.takeSnapshot(); T.snapshotDocument(s);
  const fit = T.fitMessages('edit', s);
  assert.ok(fit.trimmed);
  const extra = JSON.stringify(fit.tools).length;
  const budget = T.tokenBudget('edit', s);
  assert.ok(T.estimateTokens(fit.messages, extra) <= budget);
  assert.strictEqual(fit.history[0].role, 'user');
  const start = hist.indexOf(fit.history[0]);
  const oneMore = T.buildApiMessages(true, hist.slice(start - 4), T.joinSystem(fit.system), { shortOld: true });
  assert.ok(T.estimateTokens(oneMore, extra) > budget, 'one more turn would not fit');
  assert.deepStrictEqual(T.buildApiMessages(true, fit.history, T.joinSystem(fit.system), { shortOld: true }), fit.messages);
});
