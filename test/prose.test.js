'use strict';
// Prose quality: the writing rules in every instruction set, the remember style profile, the measured style line
// of the turn context, Munin persona turns without a system message, Munin's sampling and reasoning fields,
// the maintenance-window 503 and the neutral quota text.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, makeSnapFor, installDocTab } = require('./lib/sandbox');
const { sseResponse } = require('./lib/streams');

let env, T, state, sandbox, snapFor;

// English: 45 sentences of 10 words, 15 dashes, straight quotes, a heading line without a period, "3.5" in a sentence.
const EN = 'Results\n' + 'The cells grew in the dish and then they died. We measured 3.5 units in each of the wells — twice. The "control" group did not change at all, as expected. '.repeat(15).trim();
// Russian: 60 sentences of 8 words, 20 dashes, guillemets, "3,5" in a sentence.
const RU = 'Клетки росли в чашке, а затем они погибли. Мы измерили 3,5 единицы в каждой лунке — дважды. Группа «контроль» совсем не изменилась, как и ожидалось. '.repeat(20).trim();
const tenWords = 'Word word word word word word word word word word. ';

before(async () => {
  env = await load();
  ({ T, state, ctx: sandbox } = env);
  snapFor = makeSnapFor(env);
  installDocTab(env);
  await T.refreshContext({ force: true });
  state.googleConnected = false;
  state.docFormat = 'markdown'; state.docModel = null; state.selection = ''; state.docTitle = 'Paper';
});

test('writing rules: one block in Auto (both rule sets), Manual and persona instructions; the structure rule is softened', () => {
  const W = T.WRITING_RULES;
  assert.ok(W.startsWith('Writing (document text and chat answers):\nW1. Write like this document\'s author on a good day'));
  assert.ok(W.length > 1800 && W.length < 2400, String(W.length)); // about 450–600 tokens
  assert.strictEqual(W.split('\n').length, 18); // the title and W1..W17
  for (const [name, text] of [['TOOLS_EDIT_RULES', T.TOOLS_EDIT_RULES], ['apiEditRules', T.apiEditRules([])], ['TOOLS_MANUAL_RULES', T.TOOLS_MANUAL_RULES],
    ['persona', T.personaInstructions('chat', false, true)], ['Munin persona', T.personaInstructions('research', false)]]) {
    assert.ok(text.endsWith(`\n\n${W}`), name);
    assert.ok(!text.includes('tone, and paragraph structure'), name);
  }
  for (const text of [T.TOOLS_EDIT_RULES, T.apiEditRules([]), T.TOOLS_MANUAL_RULES]) {
    assert.ok(text.includes('its meaning and terminology; keep its paragraph structure unless the user asks you to rewrite or shorten it.'));
  }
  assert.ok(W.includes('"является"') && W.includes('is consistent with → is associated with → predicts → leads to → causes'));
  assert.ok(!/\$\{|\d{2,} words/.test(W)); // static: no per-turn values
});

test('writing rules reach the requests of every provider and mode, once', () => {
  state.docText = EN;
  for (const prov of ['munin', 'openai', 'anthropic']) {
    for (const mode of ['edit', 'manual', 'chat']) {
      const body = JSON.stringify(T.buildRequest(mode, snapFor(prov)).body);
      assert.strictEqual(body.split(JSON.stringify(T.WRITING_RULES).slice(1, -1)).length, 2, `${prov} ${mode}`);
    }
  }
});

test('the remember note offers a style profile line, under 80 tokens', () => {
  assert.ok(T.REMEMBER_NOTE.endsWith(T.STYLE_PROFILE_NOTE));
  assert.ok(T.STYLE_PROFILE_NOTE.includes('"learn my style"') && T.STYLE_PROFILE_NOTE.includes('replacing an earlier style line'));
  assert.ok(T.STYLE_PROFILE_NOTE.length / 4 < 80);
});

test('docStyleStats: sentence length, dashes and quotes in English and Russian; the 400-word threshold', () => {
  deq(T.docStyleStats(EN), { words: 451, sentenceWords: 10, dashesPer1000: 33.3, quotes: '"straight"' });
  deq(T.docStyleStats(RU), { words: 480, sentenceWords: 8, dashesPer1000: 41.7, quotes: '«guillemets»' });
  assert.strictEqual(T.docStyleStats(tenWords.repeat(39) + 'One two three four five six seven eight nine.'), null); // 399 words
  deq(T.docStyleStats(tenWords.repeat(40)), { words: 400, sentenceWords: 10, dashesPer1000: 0, quotes: null });
  assert.strictEqual(T.docStyleStats('word '.repeat(500)), null); // no sentences: a list, not prose
  assert.strictEqual(T.docStyleStats(tenWords.repeat(40) + '“a” “b” "c"').quotes, '“curly”');
  // a range or a hyphenated word is not a dash; a spaced hyphen or en dash is
  assert.strictEqual(T.docStyleStats(tenWords.repeat(40) + 'Pages 1–3 are well-known. A - b – c.').dashesPer1000, 4.9);
  // only the first STYLE_SAMPLE_CHARS characters are measured
  assert.strictEqual(T.docStyleStats('x'.repeat(T.STYLE_SAMPLE_CHARS) + tenWords.repeat(100)), null);
});

test('the style line: in the turn context of tools turns (bold only with the Docs API), once in Munin persona turns', () => {
  state.docText = EN; state.docFormat = 'markdown'; state.docModel = null;
  const line = 'Style of the document: average sentence 10 words; dashes 33.3 per 1,000 words; quotes "straight".';
  const ctx = T.buildTurnContext('edit', snapFor('anthropic'));
  assert.ok(ctx.includes(`</document>\n${line}\nCurrent selection`), ctx);
  assert.ok(!T.shortContext(ctx).includes('Style of the document')); // Munin's older turns drop it
  // the Docs API model adds "bold in body" (headings do not count)
  const model = { lines: [{ line: 1, text: 'Results', heading: 1, runs: [{ s: 0, e: 7, bold: true }] }, { line: 2, text: 'The cells grew.', heading: 0, runs: [] }] };
  const api = { docText: EN, docFormat: 'docs-api', model };
  assert.ok(T.styleLine(api).endsWith('quotes "straight"; bold in body: no.'));
  model.lines[1].runs = [{ s: 4, e: 9, bold: true }];
  assert.ok(T.styleLine(api).endsWith('bold in body: yes.'));
  // too short: no line
  state.docText = 'A short note.';
  assert.ok(!T.buildTurnContext('edit', snapFor('anthropic')).includes('Style of the document'));
  // Munin persona turns: no turn context; the line follows the excerpt, exactly once in the request
  state.docText = EN;
  const snap = snapFor('munin');
  assert.strictEqual(T.buildTurnContext('chat', snap), '');
  state.messages = [{ role: 'user', content: 'Is this clear?' }];
  const body = JSON.stringify(T.buildRequest('chat', snap).body);
  assert.strictEqual(body.split('Style of the document:').length, 2);
  assert.ok(body.includes(`</document>\\n${JSON.stringify(line).slice(1, -1)}`));
});

test('Munin persona turns: no system message; the instructions open the newest user message', () => {
  state.docText = EN; state.docInstructions = 'Use British English.';
  state.messages = [
    { role: 'user', content: 'first question' }, { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'second question' },
  ];
  try {
    const req = T.buildRequest('research', snapFor('munin'));
    assert.strictEqual(req.kind, 'persona');
    const msgs = req.body.messages;
    assert.ok(msgs.every((m) => m.role === 'user' || m.role === 'assistant'));
    deq(msgs.slice(0, 2), [{ role: 'user', content: 'first question' }, { role: 'assistant', content: 'first answer' }]);
    const last = msgs[msgs.length - 1].content;
    assert.ok(last.startsWith('<instructions>\nThe user is working on a Google Docs document'));
    assert.ok(last.endsWith('</instructions>\n\nsecond question'));
    assert.ok(last.includes('<document title="Paper"') && last.includes('The cells grew in the dish'));
    assert.ok(last.includes(T.UNTRUSTED_DATA_NOTE) && last.includes('<document_instructions>\nUse British English.'));
    assert.ok(last.includes('Current selection in the document:'));
    // the stored history is not changed
    assert.strictEqual(state.messages[2].content, 'second question');
    // OpenAI and Anthropic persona turns keep their system prompt
    assert.ok(T.buildRequest('research', snapFor('anthropic')).body.system[0].text.startsWith('The user is working'));
    assert.ok(T.buildRequest('chat', snapFor('openai')).body.instructions.startsWith('The user is working'));
    // the helper on its own: a history without a user message gets one
    deq(T.personaMessages([{ role: 'system', content: 'S' }]), [{ role: 'user', content: '<instructions>\nS\n</instructions>' }]);
  } finally { state.docInstructions = ''; }
});

test('Munin sampling, reply limit and reasoning effort; nothing for OpenAI and Anthropic', () => {
  state.docText = EN;
  state.messages = [{ role: 'user', content: 'Fix it' }];
  const body = T.buildRequest('edit', snapFor('munin')).body;
  assert.strictEqual(body.max_tokens, 8192);
  deq([body.temperature, body.top_p, body.top_k, body.presence_penalty], [0.7, 0.95, 20, 1.0]);
  deq(body.chat_template_kwargs, { reasoning_effort: 'low' });
  // a request without tools (the self-test probe) samples the same way but sets no reasoning effort
  const probe = T.buildRequest('edit', snapFor('munin'), { history: [{ role: 'user', content: 'OK?' }], noTools: true, maxTokens: 1024 }).body;
  assert.strictEqual(probe.temperature, 0.7); assert.strictEqual(probe.chat_template_kwargs, undefined);
  // the persona pipeline takes none of these
  const persona = T.buildRequest('chat', snapFor('munin')).body;
  for (const k of ['temperature', 'top_p', 'top_k', 'presence_penalty', 'chat_template_kwargs', 'max_tokens']) assert.strictEqual(persona[k], undefined, k);
  for (const prov of ['openai', 'anthropic']) {
    assert.strictEqual(env.PROVIDERS[prov].sampling, undefined);
    const b = T.buildRequest('edit', snapFor(prov)).body;
    for (const k of ['temperature', 'top_p', 'top_k', 'presence_penalty', 'chat_template_kwargs']) assert.strictEqual(b[k], undefined, `${prov} ${k}`);
  }
  deq(T.samplingFields(env.PROVIDERS.openai), {});
});

// A JSON error response with an optional Retry-After header.
function errorResponse(status, body, retryAfter) {
  const r = sseResponse(JSON.stringify(body), status);
  r.headers = { get: (n) => (n.toLowerCase() === 'retry-after' && retryAfter != null ? String(retryAfter) : null) };
  return r;
}

test('Munin maintenance window (HTTP 503 with next_start): a notice with the local time, never retried', async () => {
  const snap = snapFor('munin');
  const req = T.buildRequest('edit', snap);
  let calls = 0;
  const next = '2026-10-30T05:00:00Z';
  sandbox.fetch = async () => { calls++; return errorResponse(503, { error: 'maintenance', next_start: next }, 3600); };
  await assert.rejects(() => T.runStream(req, new AbortController().signal, snap, {}), (e) => {
    assert.strictEqual(e.maintenance, true);
    assert.ok(/^Munin is in its nightly maintenance window; it is back at .+\.$/.test(e.message), e.message);
    assert.ok(/\d/.test(T.localTime(next)) && e.message.endsWith(`back at ${T.localTime(next)}.`)); // the user's locale
    return true;
  });
  assert.strictEqual(calls, 1);
  assert.strictEqual(T.localTime('soon'), '');
  // an unreadable next_start: Retry-After, then the generic text
  sandbox.fetch = async () => errorResponse(503, { next_start: 'soon' }, 1800);
  await assert.rejects(() => T.runStream(req, new AbortController().signal, snap, {}), (e) => e.message === 'Munin is in its nightly maintenance window; it is back in about 30 min.');
  sandbox.fetch = async () => errorResponse(503, { next_start: 'soon' });
  await assert.rejects(() => T.runStream(req, new AbortController().signal, snap, {}), (e) => e.message === 'Munin is in its nightly maintenance window (HTTP 503); try again later.');
  // the persona stream shows the same notice
  sandbox.fetch = async () => errorResponse(503, { next_start: next });
  const preq = T.buildRequest('chat', snap);
  await assert.rejects(() => T.streamPersona(preq, new AbortController().signal, snap, {}), (e) => e.maintenance === true && e.message.startsWith('Munin is in its nightly maintenance window; it is back at'));
  // OpenAI's 503 with the same body is an ordinary busy server
  const osnap = snapFor('openai');
  sandbox.fetch = async () => errorResponse(503, { next_start: next });
  await assert.rejects(() => T.streamResponses(T.buildRequest('edit', osnap), new AbortController().signal, osnap, {}), (e) => !e.maintenance && e.message.startsWith('API error 503'));
});

test('Munin quota: a neutral text, with the reset time when the body gives one', async () => {
  const snap = snapFor('munin');
  const req = T.buildRequest('edit', snap);
  sandbox.fetch = async () => errorResponse(429, { error: { message: 'Monthly token quota exceeded' } });
  await assert.rejects(() => T.runStream(req, new AbortController().signal, snap, {}), (e) => {
    assert.strictEqual(e.message, 'The monthly token quota of this Munin API key is used up (HTTP 429). Check your usage in Munin Chat → Settings.');
    return e.quota === true;
  });
  sandbox.fetch = async () => errorResponse(429, { error: { message: 'quota', reset_at: '2026-11-01T00:00:00Z' } });
  await assert.rejects(() => T.runStream(req, new AbortController().signal, snap, {}), (e) => /used up \(HTTP 429\); it resets on .+\. Check your usage/.test(e.message) && !e.message.includes('100M'));
});
