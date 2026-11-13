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
  assert.ok(W.length > 1800 && W.length < 2600, String(W.length)); // about 450–650 tokens (W11 carries the [[?]] rule)
  assert.strictEqual(W.split('\n').length, 16); // the title and W1..W15
  // merged lines keep their examples: W5 (run-ups, sayings, tails), W9 (claim strength and rewrites), W15 (tools, HTTP codes)
  assert.ok(W.includes('\nW5. No run-ups ("It is worth noting that", "Importantly,"; "In order to" → "To"), deep-sounding sayings ("at its core", "the real question is") or ", highlighting/ensuring/reflecting …" tails'));
  assert.ok(W.includes('\nW15. Never explain your tools or their parameters to the user, and give no HTTP codes or server messages: say what happened in plain words.'));
  // the document subset (revise_section): the rules about the text, without the chat rules and W9's chat clause
  const D = T.DOCUMENT_WRITING_RULES;
  assert.strictEqual(D.split('\n').length, 13);
  for (const s of ['Reread new text once', 'In chat, give the answer', 'Never explain your tools', 'say in the chat']) assert.ok(!D.includes(s), s);
  assert.ok(D.includes('unless the request removes that content. Asked to rewrite') && D.includes('\nW11. Add no facts'));
  for (const [name, text] of [['TOOLS_EDIT_RULES', T.TOOLS_EDIT_RULES], ['apiEditRules', T.apiEditRules([])], ['TOOLS_MANUAL_RULES', T.TOOLS_MANUAL_RULES],
    ['persona', T.personaInstructions('chat', false, true)], ['Munin persona', T.personaInstructions('research', false)]]) {
    assert.ok(text.endsWith(`\n\n${W}`), name);
    assert.ok(!text.includes('tone, and paragraph structure'), name);
  }
  // the scope rule is a core rule of every tools-mode head, said once, not in each mode's rules
  // the document's own term wins over a variant, and sound wording stays (writing eval, stage 1: improve requests kept the
  // drifted term and reworded the author's sound sentences)
  for (const mode of ['edit', 'manual', 'plan']) assert.ok(T.coreRules(mode).includes('its meaning and the document\'s terms (a variant of one goes back to it); keep wording that is not wrong, and the paragraph structure unless the user asks you to rewrite or shorten it.'), mode);
  for (const text of [T.TOOLS_EDIT_RULES, T.apiEditRules([]), T.TOOLS_MANUAL_RULES]) assert.ok(!text.includes('Change only what the user asked for'));
  // "keep every number" and "shorten" meet in W9: the request may remove content, and the answer says what was dropped
  assert.ok(W.includes('unless the request removes that content; then say in the chat what was dropped.') && W.includes('keep every supported claim the request does not remove.'));
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

test('the style profile is in remember\'s definition; the head keeps one remember sentence', () => {
  const d = T.TOOL_DEFS.remember.function.description;
  assert.ok(d.includes('"learn my style"') && d.includes('replacing an earlier style line') && d.includes('never on your own initiative'));
  assert.strictEqual(T.REMEMBER_NOTE, 'If a request sounds like a standing rule but does not say so, ask whether it goes to DOC.md or MAIN.md; never mention these files otherwise.');
});

test('docStyleStats: sentence length, dashes and quotes in English and Russian; the 400-word threshold', () => {
  deq(T.docStyleStats(EN), { words: 451, sentenceWords: 10, dashesPer1000: 33.3, hedgesPer100: 0, passivePercent: 0, quotes: '"straight"' });
  // Russian: no passive rate (the -ся verbs and short participles are too ambiguous)
  deq(T.docStyleStats(RU), { words: 480, sentenceWords: 8, dashesPer1000: 41.7, hedgesPer100: 0, passivePercent: null, quotes: '«guillemets»' });
  assert.strictEqual(T.docStyleStats(tenWords.repeat(39) + 'One two three four five six seven eight nine.'), null); // 399 words
  deq(T.docStyleStats(tenWords.repeat(40)), { words: 400, sentenceWords: 10, dashesPer1000: 0, hedgesPer100: 0, passivePercent: 0, quotes: null });
  assert.strictEqual(T.docStyleStats('word '.repeat(500)), null); // no sentences: a list, not prose
  assert.strictEqual(T.docStyleStats(tenWords.repeat(40) + '“a” “b” "c"').quotes, '“curly”');
  // a range or a hyphenated word is not a dash; a spaced hyphen or en dash is
  assert.strictEqual(T.docStyleStats(tenWords.repeat(40) + 'Pages 1–3 are well-known. A - b – c.').dashesPer1000, 4.9);
  // only the first STYLE_SAMPLE_CHARS characters are measured
  assert.strictEqual(T.docStyleStats('x'.repeat(T.STYLE_SAMPLE_CHARS) + tenWords.repeat(100)), null);
});

test('the style line: in the turn context of tools turns (bold only with the Docs API), once in Munin persona turns', () => {
  state.docText = EN; state.docFormat = 'markdown'; state.docModel = null;
  const line = 'Style of the document: average sentence 10 words; dashes 33.3 per 1,000 words; hedges 0/100 words; passive 0%; quotes "straight".';
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
    assert.ok(last.includes(T.UNTRUSTED_DATA_NOTE) && last.includes('<DOC.md>\nUse British English.'));
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

test('Munin sampling per round, reply limit and reasoning effort; nothing for OpenAI and Anthropic', () => {
  state.docText = EN;
  state.messages = [{ role: 'user', content: 'Fix it' }];
  const sampling = (b) => [b.temperature, b.top_p, b.top_k, b.presence_penalty];
  // a request that offers the writing tools copies document text: no presence penalty, a lower temperature
  const body = T.buildRequest('edit', snapFor('munin')).body;
  assert.ok(body.tools.some((t) => t.function.name === 'replace_selection' || t.function.name === 'replace_text'));
  assert.strictEqual(body.max_tokens, 8192);
  deq(sampling(body), [0.6, 0.95, 20, 0]);
  deq(body.chat_template_kwargs, { reasoning_effort: 'low' });
  // Manual and Plan (reading tools only): the tools profile too (old_text, scopes copy document text)
  for (const mode of ['manual', 'plan']) {
    const ro = T.buildRequest(mode, snapFor('munin')).body;
    assert.ok(ro.tools.length > 0);
    deq(sampling(ro), [0.6, 0.95, 20, 0], mode);
  }
  // a request without tools (the wrap-up, the self-test probe): the prose profile, an explicit low effort
  const probe = T.buildRequest('edit', snapFor('munin'), { history: [{ role: 'user', content: 'OK?' }], noTools: true, maxTokens: 1024 }).body;
  deq(sampling(probe), [0.7, 0.95, 20, 1.0]); deq(probe.chat_template_kwargs, { reasoning_effort: 'low' });
  // the profiles themselves
  deq(T.samplingFields(env.PROVIDERS.munin, 'tools'), { temperature: 0.6, top_p: 0.95, top_k: 20, presence_penalty: 0 });
  deq(T.samplingFields(env.PROVIDERS.munin, 'summary'), { temperature: 0.3, top_p: 0.95, top_k: 20, presence_penalty: 0 });
  deq(T.samplingFields(env.PROVIDERS.munin), { temperature: 0.7, top_p: 0.95, top_k: 20, presence_penalty: 1.0 });
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
