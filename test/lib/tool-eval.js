'use strict';
// The tool-behaviour eval (development/tools/tool-eval.js, test/tool-eval.test.js): a case = a short document, a
// selection, the mode (Auto / Manual, Docs API on / off), paraphrases of one request and the expected tool
// trajectory. Each run is one real turn (startTurn → toolLoop) in a fresh sandbox, on test/lib/fake-docs.js (Docs API
// on) or a fake Docs tab (export and paste), against a live provider (ctx.fetch → Node's fetch) or recorded rounds
// (dry: SSE built with test/lib/streams.js). Cards are decided like a user would: edits allowed, ask_user answered,
// open_document denied.
const fs = require('fs');
const path = require('path');
const { load, installDocTab, installIdentity, tabExportOnly } = require('./sandbox');
const { sseResponse, ev, tu, msgStart, stopTool, textRound } = require('./streams');
const { fakeDocsServer } = require('./fake-docs');
const { WRITE_TOOLS, gradeTranscript } = require('./defect-bench');

const ROOT = path.join(__dirname, '..', '..');
const CHARS_PER_TOKEN = 4;

// ---- The document of a case --------------------------------------------------------------------------------------
// Lines with Markdown heading marks ("# " heading 1, "## " heading 2). A fixture (plain text, one paragraph per line):
// the first line is the title, short lines without a final mark are headings.
function caseLines(c, root = ROOT) {
  if (Array.isArray(c.doc)) return c.doc.map(String);
  if (c.fixture) {
    const lines = fs.readFileSync(path.join(root, c.fixture), 'utf8').replace(/\n+$/, '').split('\n');
    return lines.map((l, i) => (i === 0 ? '# ' + l : l.length < 70 && !/[.!?:;)\]]$/.test(l) && !/^\[\d+\]/.test(l) ? '## ' + l : l));
  }
  throw new Error(`case ${c.id}: no doc or fixture`);
}
const plainLine = (l) => l.replace(/^#{1,2} /, '');
function docsSpec(lines) {
  const items = lines.map((l) => (l.startsWith('## ') ? { p: plainLine(l), style: 'HEADING_2' } : l.startsWith('# ') ? { p: plainLine(l), style: 'HEADING_1' } : { p: l }));
  return { documentId: 'DOC123', title: 'Eval Doc', tabs: [{ id: 't.0', title: 'Main', items }] };
}

// ---- Recorded rounds (dry run) ------------------------------------------------------------------------------------
// A round: { text } or { calls: [[name, args], ...] }. usage: the prompt size of the request it answers (estimated).
const cc = (o) => `data: ${JSON.stringify(o)}\n\n`;
function muninRound(round, ids, prompt) {
  const usage = cc({ choices: [], usage: { prompt_tokens: prompt, completion_tokens: 20, total_tokens: prompt + 20 } });
  if (!round.calls) return cc({ choices: [{ index: 0, delta: { content: round.text || '' } }] }) + cc({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + usage + 'data: [DONE]\n\n';
  const deltas = round.calls.map(([name, args], i) => cc({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: ids(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }));
  return deltas.join('') + cc({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + usage + 'data: [DONE]\n\n';
}
function anthropicRound(round, ids) {
  if (!round.calls) return textRound(round.text || '');
  return msgStart + round.calls.map(([name, args], i) => tu(i, ids(), name, args)).join('') + stopTool;
}
function openaiRound(round, ids, prompt) {
  const usage = { input_tokens: prompt, output_tokens: 20, total_tokens: prompt + 20 };
  if (!round.calls) {
    const t = round.text || '';
    return ev('response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, delta: t }) +
      ev('response.completed', { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', id: 'msg_d', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: t }] }], usage } });
  }
  const items = round.calls.map(([name, args]) => { const id = ids(); return { type: 'function_call', id: 'fc_' + id, call_id: id, name, arguments: JSON.stringify(args), status: 'completed' }; });
  return items.map((item, i) => ev('response.output_item.added', { type: 'response.output_item.added', output_index: i, item: { ...item, arguments: '', status: 'in_progress' } }) +
    ev('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', output_index: i, delta: item.arguments }) +
    ev('response.output_item.done', { type: 'response.output_item.done', output_index: i, item })).join('') +
    ev('response.completed', { type: 'response.completed', response: { status: 'completed', output: items, usage } });
}
const ROUND_BUILDERS = { munin: muninRound, anthropic: anthropicRound, openai: openaiRound };
// The recorded script of run `i` of a case: case.dry is a list of scripts, used in turn (two scripts: runs alternate).
function dryScript(c, i) {
  const scripts = Array.isArray(c.dry) && c.dry.length ? c.dry : [[{ text: '(dry run: no recorded rounds for this case)' }]];
  return scripts[i % scripts.length];
}

// ---- One run --------------------------------------------------------------------------------------------------------
// opts: { provider, model, apiKey, dry (bool), runIndex, timeoutMs, root, fetchImpl (live: default global fetch) }.
// Returns { outcome, errors, notices, calls: [{ name, args, ok, round, content }], rounds: [[name]], answer, finalText,
// usage: { prompt, completion }, requests: [{ chars }], cards: [{ kind, decision }], messages }.
async function runOnce(c, prompt, opts) {
  const { provider, dry } = opts;
  const env = await load({ settle: 0 });
  const { T, state, chrome, ctx } = env;
  installDocTab(env);
  const lines = caseLines(c, opts.root);
  const doc = { text: lines.join('\n'), selection: c.selection || '' };
  chrome.tabs.sendMessage = async (id, msg) => {
    if (msg.type === 'GET_SELECTION') return { ok: true, text: doc.selection };
    if (msg.type === 'GET_DOC_TEXT') return { ok: true, text: doc.text, format: 'markdown', title: 'Eval Doc' };
    if (msg.type === 'REPLACE_SELECTION') {
      const old = msg.expected || doc.selection;
      if (old && doc.text.includes(old)) doc.text = doc.text.replace(old, msg.text);
      else doc.text += '\n' + msg.text; // a paste at the cursor
      doc.selection = '';
      return { ok: true, verified: true };
    }
    return { ok: true, title: 'Eval Doc' };
  };
  const errors = [];
  const notices = [];
  const origError = T.addError;
  const origNotice = T.addNotice;
  ctx.addError = (m, ...a) => { errors.push(String(m)); return origError(m, ...a); };
  ctx.addNotice = (m, ...a) => { notices.push(String(m)); return origNotice(m, ...a); };
  let fake = null;
  if (c.docsApi) {
    const ident = installIdentity(env);
    fake = fakeDocsServer(docsSpec(lines));
    ident.granted = true;
    state.googleConnected = true;
  }
  state.settings.provider = provider;
  Object.assign(state.settings.providers[provider], { apiKey: opts.apiKey || 'dry-key', ...(opts.model ? { model: opts.model } : {}) });
  state.applyMode = c.mode === 'manual' ? 'manual' : 'auto';
  await T.refreshContext({ force: true });
  await T.createChat();

  const requests = [];
  const script = dry ? dryScript(c, opts.runIndex || 0) : null;
  let seq = 0;
  const ids = () => `dry_${++seq}`;
  const providerFetch = async (url, init) => {
    const body = init && typeof init.body === 'string' ? init.body : '';
    requests.push({ chars: body.length });
    if (!dry) return (opts.fetchImpl || fetch)(url, init);
    const round = script[Math.min(requests.length - 1, script.length - 1)];
    return sseResponse(ROUND_BUILDERS[provider](round, ids, Math.round(body.length / CHARS_PER_TOKEN)));
  };
  const route = async (url, init) => (fake && (await fake.fetch(url, init))) || providerFetch(url, init);
  ctx.fetch = c.docsApi ? route : tabExportOnly(route);

  // The user at the cards: edits allowed, ask_user answered (case.answer, default the first option), documents not opened.
  const cards = [];
  const decider = setInterval(() => {
    for (const [id, p] of T.pendingPreviews) {
      const html = String(p.card && p.card.innerHTML || '');
      const ask = String(p.card && p.card.className || '').includes('ask');
      const kind = ask ? 'ask' : html.includes('open_document') ? 'open' : 'edit';
      const decision = kind === 'ask' ? (c.answer || 'option:0') : kind === 'open' ? 'reject' : 'accept';
      cards.push({ kind, decision });
      T.decidePreview(id, decision);
    }
  }, 10);
  const timeout = setTimeout(() => { if (state.abort) state.abort.abort(); }, opts.timeoutMs || (dry ? 20000 : 240000));
  let outcome;
  try {
    T.el.input.value = prompt;
    outcome = await T.startTurn(null);
  } finally {
    clearInterval(decider);
    clearTimeout(timeout);
  }
  const messages = JSON.parse(JSON.stringify(state.messages));
  const finalText = fake ? (await T.fetchDocModel('DOC123', 't.0')).text : doc.text;
  return { ...trajectory(messages), outcome, errors, notices, finalText, requests, cards, messages };
}

// The calls of a turn's messages, with their results: { calls, rounds, answer, usage }.
function trajectory(messages) {
  const results = new Map(messages.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, m]));
  const calls = [];
  const rounds = [];
  let answer = '';
  const usage = { prompt: 0, completion: 0 };
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    if (m._usage) { usage.prompt += Number(m._usage.prompt_tokens) || 0; usage.completion += Number(m._usage.completion_tokens) || 0; }
    if (typeof m.content === 'string' && m.content.trim()) answer = m.content;
    if (!Array.isArray(m.tool_calls) || !m.tool_calls.length) continue;
    const names = [];
    for (const tc of m.tool_calls) {
      const r = results.get(tc.id);
      let args = null;
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) { args = tc.function.arguments; }
      calls.push({ name: tc.function.name, args, ok: !!(r && r._ok), round: rounds.length, content: r ? String(r.content).slice(0, 160) : '(no result)' });
      names.push(tc.function.name);
    }
    rounds.push(names);
  }
  return { calls, rounds, answer, usage };
}
// A run's trajectory as one string, for the flip rate: responses separated by " | ", failed calls marked "!".
function trajectoryKey(run) {
  const rounds = [];
  for (const c of run.calls) (rounds[c.round] = rounds[c.round] || []).push(c.name + (c.ok ? '' : '!'));
  return rounds.map((r) => (r || []).join('+')).join(' | ');
}

// ---- Expectations ---------------------------------------------------------------------------------------------------
// expect: { order: ["a|b", ...] (successful calls, in this order, others may come between), forbid: [name | "write"]
// (never called, even if refused), alone: [name] (the only call of its response), max: { name | "write": n },
// finalText / finalTextNot / answer / answerNot: regex sources (flags iu) on the document after the turn / the final
// answer }. A run also fails when the turn did not end normally, and on the transcript graders of defect-bench.js.
const expand = (name) => (name === 'write' ? WRITE_TOOLS : [name]);
function evaluate(expect = {}, run) {
  const failures = [];
  if (run.outcome !== 'done') failures.push(`turn ${run.outcome}${run.errors.length ? ': ' + run.errors[0].slice(0, 120) : ''}`);
  const okNames = run.calls.filter((c) => c.ok).map((c) => c.name);
  let at = 0;
  for (const step of expect.order || []) {
    const alts = step.split('|').flatMap(expand);
    const i = okNames.findIndex((n, k) => k >= at && alts.includes(n));
    if (i < 0) { failures.push(`missing ${step}${at ? ' (after the earlier steps)' : ''}`); break; }
    at = i + 1;
  }
  for (const f of expect.forbid || []) {
    const hit = run.calls.filter((c) => expand(f).includes(c.name));
    if (hit.length) failures.push(`called ${[...new Set(hit.map((c) => c.name))].join(', ')} (forbidden: ${f})`);
  }
  for (const a of expect.alone || []) {
    if (run.rounds.some((names) => names.includes(a) && names.length > 1)) failures.push(`${a} not alone in its response`);
  }
  for (const [name, n] of Object.entries(expect.max || {})) {
    const count = run.calls.filter((c) => expand(name).includes(c.name)).length;
    if (count > n) failures.push(`${name} called ${count} times (max ${n})`);
  }
  const re = (s) => new RegExp(s, 'iu');
  if (expect.finalText && !re(expect.finalText).test(run.finalText)) failures.push(`document does not match /${expect.finalText}/`);
  if (expect.finalTextNot && re(expect.finalTextNot).test(run.finalText)) failures.push(`document matches /${expect.finalTextNot}/`);
  if (expect.answer && !re(expect.answer).test(run.answer)) failures.push(`answer does not match /${expect.answer}/`);
  if (expect.answerNot && re(expect.answerNot).test(run.answer)) failures.push(`answer matches /${expect.answerNot}/`);
  // The transcript graders of the defect benchmark: a write after a check-only request, a claimed check without a read.
  for (const g of gradeTranscript(run.messages || [])) {
    if (!g.rewrote.pass) failures.push(`rewrote when only asked to check (${[...g.rewrote.writes, g.rewrote.block ? 'edit block' : ''].filter(Boolean).join(', ')})`);
    if (!g.claimed.pass) failures.push(`claimed a check without reading ("${g.claimed.claim}")`);
  }
  return { pass: !failures.length, failures };
}

// ---- Statistics ---------------------------------------------------------------------------------------------------
// The share of differing pairs among the trajectories of one paraphrase's repeats (0 with fewer than two).
function flipRate(keys) {
  let pairs = 0;
  let diff = 0;
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) { pairs++; if (keys[i] !== keys[j]) diff++; }
  return pairs ? diff / pairs : 0;
}
// A case's numbers from its runs ([{ paraphrase, pass, run }]): pass rate, flip rate (mean over paraphrases), error rate
// (the turn failed or stopped), degraded rate (a call failed or was refused), recovery rate (degraded runs that still
// passed), tokens.
function caseStats(runs) {
  const n = runs.length;
  const by = new Map();
  for (const r of runs) { if (!by.has(r.paraphrase)) by.set(r.paraphrase, []); by.get(r.paraphrase).push(r); }
  const flips = [...by.values()].filter((l) => l.length > 1).map((l) => flipRate(l.map((r) => trajectoryKey(r.run))));
  const degraded = runs.filter((r) => r.run.outcome === 'done' && r.run.calls.some((c) => !c.ok));
  return {
    runs: n,
    passed: runs.filter((r) => r.pass).length,
    perParaphrase: [...by.entries()].map(([p, l]) => ({ paraphrase: p, passed: l.filter((r) => r.pass).length, runs: l.length })),
    flipRate: flips.length ? flips.reduce((a, b) => a + b, 0) / flips.length : 0,
    errorRate: n ? runs.filter((r) => r.run.outcome !== 'done').length / n : 0,
    degradedRate: n ? degraded.length / n : 0,
    degraded: degraded.length,
    recovered: degraded.filter((r) => r.pass).length,
    tokens: runs.reduce((t, r) => t + r.run.usage.prompt + r.run.usage.completion, 0),
    requests: runs.reduce((t, r) => t + r.run.requests.length, 0),
  };
}

// ---- The eval ---------------------------------------------------------------------------------------------------------
// cases: the case list; opts: { provider, model, apiKey, dry, repeats (3), budget (tokens; runs stop starting once
// the recorded usage passes it), paraphrases (indices to run, default all), onRun(info) }. Returns { cases: [{ id,
// stats, runs: [{ paraphrase, repeat, pass, failures, trajectory, outcome, tokens }] }], tokens, skipped }.
async function runEval(cases, opts) {
  const repeats = opts.repeats || 3;
  const out = { cases: [], tokens: 0, skipped: 0 };
  for (const c of cases) {
    const runs = [];
    const prompts = c.prompts.map((p, i) => [i, p]).filter(([i]) => !opts.paraphrases || opts.paraphrases.includes(i));
    let k = 0;
    for (const [pi, prompt] of prompts) {
      for (let rep = 0; rep < repeats; rep++, k++) {
        if (opts.budget && out.tokens >= opts.budget) { out.skipped++; continue; }
        const run = await runOnce(c, prompt, { ...opts, runIndex: k });
        const verdict = evaluate(c.expect, run);
        const tokens = run.usage.prompt + run.usage.completion;
        out.tokens += tokens;
        runs.push({ paraphrase: pi, repeat: rep, ...verdict, run });
        if (opts.onRun) opts.onRun({ case: c.id, paraphrase: pi, repeat: rep, pass: verdict.pass, failures: verdict.failures, trajectory: trajectoryKey(run), tokens });
      }
    }
    out.cases.push({
      id: c.id, stats: caseStats(runs),
      runs: runs.map((r) => ({ paraphrase: r.paraphrase, repeat: r.repeat, pass: r.pass, failures: r.failures, trajectory: trajectoryKey(r.run),
        outcome: r.run.outcome, tokens: r.run.usage.prompt + r.run.usage.completion, requestChars: r.run.requests.map((q) => q.chars), cards: r.run.cards })),
    });
  }
  return out;
}

// The case file: { docs?: { name: lines }, cases: [...] } or a list. Each case needs a unique id, prompts (one or more)
// and a doc (lines, or "@name" of docs) or a fixture (a path from the checkout root).
function loadCases(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const docs = (!Array.isArray(data) && data.docs) || {};
  const cases = Array.isArray(data) ? data : data.cases;
  const ids = new Set();
  return cases.map((c) => {
    if (!c.id || ids.has(c.id)) throw new Error(`case without a unique id: ${JSON.stringify(c).slice(0, 80)}`);
    ids.add(c.id);
    if (!Array.isArray(c.prompts) || !c.prompts.length) throw new Error(`case ${c.id}: no prompts`);
    const doc = typeof c.doc === 'string' && c.doc.startsWith('@') ? docs[c.doc.slice(1)] : c.doc;
    if (c.doc && !Array.isArray(doc)) throw new Error(`case ${c.id}: unknown document ${c.doc}`);
    if (!doc && !c.fixture) throw new Error(`case ${c.id}: no doc or fixture`);
    if (c.selection && doc && !doc.join('\n').includes(c.selection)) throw new Error(`case ${c.id}: the selection is not in the document`);
    return { ...c, doc };
  });
}

module.exports = { CHARS_PER_TOKEN, caseLines, docsSpec, runOnce, trajectory, trajectoryKey, evaluate, flipRate, caseStats, runEval, loadCases };
