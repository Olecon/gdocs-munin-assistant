'use strict';
// The tool-behaviour eval (development/tools/tool-eval.js, test/tool-eval.test.js): a case = a short document, a
// selection, the mode (Auto / Manual / Plan, Docs API on / off), paraphrases of one request ("/side …": a side question;
// optionally later messages of the same chat: case.turns) and the expected tool trajectory. Each run is one real chat (startTurn → toolLoop per
// message) in a fresh sandbox, on test/lib/fake-docs.js (Docs API on) or a fake Docs tab (export and paste), against a
// live provider (ctx.fetch → Node's fetch) or recorded rounds (dry: SSE built with test/lib/streams.js). Cards are
// decided like a user would, or as the case scripts them (case.cards): edits allowed, ask_user answered, reference
// lookups not allowed, open_document denied.
const fs = require('fs');
const path = require('path');
const { load, installDocTab, installIdentity, tabExportOnly } = require('./sandbox');
const { sseResponse, ev, tu, msgStart, stopTool, textRound } = require('./streams');
const { fakeDocsServer, specFromBody } = require('./fake-docs');
const { WRITE_TOOLS, gradeTranscript } = require('./defect-bench');

const ROOT = path.join(__dirname, '..', '..');
const CHARS_PER_TOKEN = 4;
// The tracked case file (development/tools/tool-eval.js reads it by default; test/tool-eval.test.js runs its scripts).
const CASES_FILE = path.join(ROOT, 'test', 'fixtures', 'tool-eval-cases.json');
// What a case may require of the configured accounts (case.requires), with the reason printed when a live run skips it.
const REQUIREMENTS = {
  'munin-key': 'needs a Munin API key (MUNIN_API_KEY): the search tool exists only while a Munin account has a key',
  'web-search': 'needs a provider with hosted web search (--provider openai or anthropic)',
};
// The requirements of a case that `met` ({ name: bool }) does not meet.
const unmetRequirements = (c, met) => (c.requires || []).filter((r) => !met[r]);

// ---- The document of a case --------------------------------------------------------------------------------------
// Lines with Markdown heading marks ("# " heading 1, "## " heading 2), or (Docs API cases) a fake-docs spec item
// { p, style, pstyle, bullet, fmt } for a line that needs list, indent or text formatting. A fixture (plain text, one
// paragraph per line): the first line is the title, short lines without a final mark are headings.
function caseLines(c, root = ROOT) {
  if (Array.isArray(c.doc)) return c.doc.map((l) => (l && typeof l === 'object' ? l : String(l)));
  if (c.fixture) {
    const lines = fs.readFileSync(path.join(root, c.fixture), 'utf8').replace(/\n+$/, '').split('\n');
    return lines.map((l, i) => (i === 0 ? '# ' + l : l.length < 70 && !/[.!?:;)\]]$/.test(l) && !/^\[\d+\]/.test(l) ? '## ' + l : l));
  }
  throw new Error(`case ${c.id}: no doc or fixture`);
}
const plainLine = (l) => (typeof l === 'object' ? String(l.p) : l.replace(/^#{1,2} /, ''));
// A line as the export path shows it (Markdown heading marks).
const markdownLine = (l) => (typeof l !== 'object' ? l : l.style === 'HEADING_1' ? '# ' + l.p : l.style === 'HEADING_2' ? '## ' + l.p : String(l.p));
// extra: the case's namedStyles and lists (fake-docs spec, per document; the named styles' indents are set after the
// server is made, see namedIndents).
function docsSpec(lines, extra = {}) {
  const items = lines.map((l) => (typeof l === 'object' ? { ...l } : l.startsWith('## ') ? { p: plainLine(l), style: 'HEADING_2' } : l.startsWith('# ') ? { p: plainLine(l), style: 'HEADING_1' } : { p: l }));
  return { documentId: 'DOC123', title: 'Eval Doc', ...(extra.namedStyles ? { namedStyles: extra.namedStyles } : {}),
    tabs: [{ id: 't.0', title: 'Main', items, ...(extra.lists ? { lists: extra.lists } : {}) }] };
}
// fake-docs models no indent in a named style: a case's namedStyles { HEADING_2: { indentStart, indentFirstLine } } (pt)
// go straight into the server's named styles, so documents.get returns them where its mask asks for named styles.
function namedIndents(fake, named = {}) {
  for (const tab of fake.tabs) {
    for (const [type, v] of Object.entries(named)) {
      const ps = tab.named[type] && tab.named[type].paragraphStyle;
      if (!ps) continue;
      for (const k of ['indentStart', 'indentFirstLine']) if (typeof v[k] === 'number') ps[k] = { magnitude: v[k], unit: 'PT' };
    }
  }
}

// ---- The final document's lines (Docs API cases), read from the fake server, not through the panel ----------------
// One entry per body paragraph: { text, style, indent: [start, firstLine], ownIndent, spaceAbove, size, bold, italic,
// listLevel, listId, numbered }. Effective values: the paragraph's own, else its named style's, else (indents) Normal
// text's, else 0; a list item without an indent of its own is drawn at its named style's indent, never its list level's
// (chrome-check line-starts in the real editor). ownIndent: the paragraph's own values (null when it has none).
// Docs returns an explicit 0 as a Dimension without a magnitude ({ unit: 'PT' }): 0, not absent.
const mag = (d) => (d && typeof d.magnitude === 'number' ? d.magnitude : d && d.unit ? 0 : null);
const first = (...xs) => { for (const x of xs) if (x != null) return x; return null; };
function lineInfo(p, tab) {
  const named = tab.named[p.style] || {};
  const normal = tab.named.NORMAL_TEXT || {};
  const ps = p.pstyle || {};
  const nps = named.paragraphStyle || {};
  const list = p.bullet ? tab.lists[p.bullet.listId] : null;
  const level = list && list.nestingLevels ? list.nestingLevels[p.bullet.level] || null : null;
  const indent = (k) => first(mag(ps[k]), mag(nps[k]), mag((normal.paragraphStyle || {})[k]), 0);
  const own = [mag(ps.indentStart), mag(ps.indentFirstLine)];
  const text = String(p.text).replace(/[-]/g, '￼'); // fake-docs keeps an object as a private-use character
  const chars = Array.from({ length: p.text.length }, (_, i) => (p.chars || [])[i] || {}).filter((_, i) => p.text[i] && p.text[i].trim());
  const nts = named.textStyle || {};
  const explicit = (k) => { const v = chars.map((ch) => ch[k]); return v.length && v.every((x) => x === v[0]) ? v[0] : undefined; };
  const flag = (k) => (chars.length ? chars.every((ch) => (ch[k] != null ? ch[k] === true : nts[k] === true)) : nts[k] === true);
  return {
    text, style: p.style || 'NORMAL_TEXT', indent: [indent('indentStart'), indent('indentFirstLine')],
    ownIndent: own.every((x) => x == null) ? null : own,
    spaceAbove: first(mag(ps.spaceAbove), mag(nps.spaceAbove), 0), spaceBelow: first(mag(ps.spaceBelow), mag(nps.spaceBelow), 0),
    size: first(explicit('size'), mag(nts.fontSize), mag((normal.textStyle || {}).fontSize)),
    bold: flag('bold'), italic: flag('italic'),
    listLevel: p.bullet ? p.bullet.level || 0 : null, listId: p.bullet ? p.bullet.listId : null,
    numbered: !!(level && level.glyphType && level.glyphType !== 'GLYPH_TYPE_UNSPECIFIED' && level.glyphType !== 'NONE'),
  };
}
function docLines(fake, tabId = 't.0') {
  const tab = fake.tabs.find((t) => t.id === tabId) || fake.tabs[0];
  const out = [];
  for (const b of tab.blocks) if (b.type === 'run') for (const p of b.paras) out.push(lineInfo(p, tab));
  return out;
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
// A Custom account speaks Chat Completions like Munin's raw path.
const ROUND_BUILDERS = { munin: muninRound, anthropic: anthropicRound, openai: openaiRound, custom: muninRound };
// The dry model list of a Custom server: the run's model and a sibling under the same scheme and folder, so the panel
// derives the shared prefix (Yandex: gpt://<folder>/) from it as from a real list.
function dryModelList(model) {
  const m = String(model || 'dry-model');
  const head = /^[a-z][a-z0-9+.-]*:\/\/[^/]+\//i.exec(m);
  return { data: [{ id: m }, { id: (head ? head[0] : '') + 'dry-other/latest' }] };
}
// The usage a provider stream reports (Chat Completions, Responses, Messages): the largest counts in it.
function streamUsage(text) {
  const max = (re) => Math.max(0, ...[...String(text).matchAll(re)].map((m) => Number(m[1]) || 0));
  return { prompt: max(/"(?:prompt_tokens|input_tokens)"\s*:\s*(\d+)/g), completion: max(/"(?:completion_tokens|output_tokens)"\s*:\s*(\d+)/g) };
}
// The tokens a run spent: its model responses and the panel's own side requests (live only; stored nowhere in the chat).
const runTokens = (run) => run.usage.prompt + run.usage.completion + (run.sideUsage ? run.sideUsage.prompt + run.sideUsage.completion : 0);
// The recorded script of run `i` of a case: case.dry is a list of scripts, used in turn (two scripts: runs alternate).
// A script is a list of rounds; for a case with later messages (case.turns) a list of such lists, one per message.
function dryScript(c, i) {
  const scripts = Array.isArray(c.dry) && c.dry.length ? c.dry : [[{ text: '(dry run: no recorded rounds for this case)' }]];
  return scripts[i % scripts.length];
}
const perTurnScript = (script) => Array.isArray(script) && Array.isArray(script[0]);
function turnRounds(script, t) {
  if (perTurnScript(script)) return script[t] && script[t].length ? script[t] : [{ text: '(dry run: no recorded rounds for this message)' }];
  return t === 0 ? script : [{ text: '(dry run: no recorded rounds for this message)' }];
}
// A request of the panel's own besides the turn's rounds (the connectivity check, a summary): no tools. It costs tokens
// live, but plays no recorded round in the dry run (it is answered "OK").
function sideRequest(body) {
  try { const b = JSON.parse(body); return !Array.isArray(b.tools) || !b.tools.length; } catch (e) { return false; }
}

// ---- Accounts and requirements ----------------------------------------------------------------------------------------
// The panel's accounts for a run: the chat's provider with its key (and model), and, when muninKey is given on another
// provider, a keyed Munin account (it makes the search tool available to a chat on OpenAI or Anthropic).
// server: what the settings row of the account holds beyond the key, as a user fills it in: { baseUrl, headers (the
// Extra headers rows), params ({ maxTokens, temperature }: Advanced) }; a Custom account needs its baseUrl.
function setAccounts(state, provider, apiKey, muninKey, model, server = null) {
  state.settings.provider = provider;
  Object.assign(state.settings.providers[provider], { apiKey, ...(model ? { model } : {}) });
  if (provider !== 'munin' && muninKey) state.settings.providers.munin.apiKey = muninKey;
  const a = server ? state.settings.accounts.find((x) => x.type === provider) : null;
  if (!a) return;
  if (server.baseUrl) a.baseUrl = String(server.baseUrl).replace(/\/+$/, '');
  if (server.headers && Object.keys(server.headers).length) a.headers = { ...server.headers };
  if (server.params && Object.keys(server.params).length) a.params = { ...server.params };
}
// Which requirements the accounts of a live run meet: { 'munin-key': bool, 'web-search': bool }. The accounts are set up
// as for a case that requires everything, and the panel's own searchAccount (src/munin-search.js; the search tool is
// offered exactly when it finds a Munin account with a key) and WEB_SEARCH_PROVIDERS (request.js webSearchTurn) decide,
// so the eval and the panel agree. No reachability check (no network). opts: { provider, apiKey, muninKey }.
async function requirementsMet(opts) {
  const { T, state } = await load({ settle: 0 });
  setAccounts(state, opts.provider, opts.apiKey || '', opts.muninKey || '', null);
  return { 'munin-key': !!T.searchAccount(null), 'web-search': T.WEB_SEARCH_PROVIDERS.includes(opts.provider) };
}

// ---- The messages of a run ------------------------------------------------------------------------------------------
// The first message is one paraphrase of case.prompts with the case's selection, mode, cards and expect; case.turns
// lists the later messages of the same chat: { prompt | prompts (paraphrases, taken at the run's paraphrase index),
// selection (default none), mode (default the case's), cards (over the case's), answer, expect }.
// A message that starts with "/side " is a side question (runSideTurn): the read-only chat turn with the edit-block
// rules, on the side thread instead of the chat; the mode button does not change it.
function caseTurns(c, prompt, paraphrase = 0) {
  const turns = [{ prompt, selection: c.selection || '', mode: c.mode, cards: c.cards || {}, answer: c.answer, expect: c.expect || {} }];
  for (const t of c.turns || []) {
    turns.push({ prompt: Array.isArray(t.prompts) ? t.prompts[paraphrase % t.prompts.length] : t.prompt, selection: t.selection || '',
      mode: t.mode || c.mode, cards: { ...(c.cards || {}), ...(t.cards || {}) }, answer: t.answer || c.answer, expect: t.expect || {} });
  }
  return turns;
}
// The panel's mode button for a case's mode ("auto", "manual" or "plan"; anything else is Auto).
const applyModeOf = (mode) => (mode === 'manual' || mode === 'plan' ? mode : 'auto');
// The decision on a card of `kind` for a turn's cards ({ access: allow | not-now, edit: allow | allow-all | deny,
// ask: "option:N" | "answers:<JSON list>" | an Other text | { match, other } (askDecision), open: allow | deny }, or a
// list of them: the n-th card of the kind in the message takes the n-th, a later one the default); the defaults are the
// old fixed ones: edits allowed, ask_user answered with the case's answer (default the first option), reference lookups
// not allowed, documents not opened.
function cardDecision(kind, turn, n = 0) {
  const given = (turn.cards || {})[kind];
  const want = Array.isArray(given) ? given[n] : given;
  if (kind === 'ask') return want || turn.answer || 'option:0';
  if (kind === 'access') return want === 'allow' ? 'accept' : 'reject';
  if (kind === 'open') return want === 'allow' ? 'accept' : 'reject';
  return want === 'deny' ? 'reject' : want === 'allow-all' ? 'accept-all' : 'accept';
}
// An ask card's scripted answer as the panel takes it (gate.js askOutcome: "option:N", "answers:<JSON list>"), for the card
// html: { match (a regex, or a list in order of preference; flags iu), other } picks the first answer of the shown question
// that matches, as a user picks the option that names what they mean, else types other; any other text is typed in Other.
const unescapeHtml = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
function askDecision(want, html) {
  if (want && typeof want === 'object') {
    const options = [...String(html || '').matchAll(/data-ask="(\d+)"[^>]*>\d+\. ([^<]*)<\/button>/g)].map((m) => [Number(m[1]), unescapeHtml(m[2])]);
    let hit = null;
    for (const re of [].concat(want.match || [])) if (!hit) hit = options.find(([, t]) => new RegExp(re, 'iu').test(t)) || null;
    return hit ? `option:${hit[0]}` : `answers:${JSON.stringify([String(want.other || '')])}`;
  }
  return /^option:\d+$/.test(want) || String(want).startsWith('answers:') ? want : `answers:${JSON.stringify([String(want)])}`;
}

// ---- One run --------------------------------------------------------------------------------------------------------
// opts: { provider, model, apiKey, muninKey (a case requiring munin-key on another provider: the Munin account's key; dry:
// a placeholder), server (the account's settings beyond the key: setAccounts; a Custom account's server URL, extra headers
// and Advanced params), dry (bool), runIndex, paraphrase (the index of prompt: later messages with paraphrases take
// theirs), timeoutMs (per message), root, fetchImpl (live: default global fetch) }.
// A Custom account loads its model list first, as Check provider does (GET /models: the shared id prefix; no tokens).
// sideUsage: the tokens of the panel's side requests, read from their live streams.
// Returns the last message's { outcome (the first that did not end normally), errors, rows, finalText, finalFormatting,
// lines } and the whole chat's { calls: [{ name, args, ok, round, turn, content }], rounds, answer (the last), usage:
// { prompt, completion }, requests: [{ chars, turn, side }], cards: [{ turn, kind, decision }], messages }, plus turns:
// the same per message (each with its own expect).
// A replay case (replayCase) carries c.replay: { body (a documents.get body: the fake server is built from it) or
// exportText and exportFormat (the export path), tabId, messages (the stored history before the message, as it is),
// docInstructions, mainInstructions }; its run also returns startText (the document before the message, as the panel reads it).
async function runOnce(c, prompt, opts) {
  const { provider, dry } = opts;
  const custom = provider === 'custom';
  const env = await load({ settle: 0 });
  const { T, state, chrome, ctx } = env;
  const docTab = installDocTab(env);
  const rp = c.replay || null;
  const lines = rp ? null : caseLines(c, opts.root);
  const doc = { text: rp ? rp.exportText || '' : lines.map(markdownLine).join('\n'), format: rp && rp.exportFormat === 'text' ? 'text' : 'markdown', selection: '' };
  chrome.tabs.sendMessage = async (id, msg) => {
    if (msg.type === 'GET_SELECTION') return { ok: true, text: doc.selection };
    if (msg.type === 'GET_DOC_TEXT') return { ok: true, text: doc.text, format: doc.format, title: 'Eval Doc' };
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
  const rows = [];
  const origError = T.addError;
  const origRow = T.addTurnRow;
  ctx.addError = (m, ...a) => { errors.push(String(m)); return origError(m, ...a); };
  ctx.addTurnRow = (m, ...a) => { rows.push(String(m)); return origRow(m, ...a); };
  let fake = null;
  if (c.docsApi) {
    const ident = installIdentity(env);
    const spec = rp ? specFromBody(rp.body, { documentId: 'DOC123' }) : docsSpec(lines, c);
    // opts.docsServer(spec, c): another server with the fake's face (test/lib/real-docs.js: the real API, reset to the spec).
    fake = opts.docsServer ? await opts.docsServer(spec, c) : fakeDocsServer(spec);
    if (!rp && !opts.docsServer) namedIndents(fake, c.namedStyles);
    ident.granted = true;
    state.googleConnected = true;
  }
  // The Docs tab the message was sent in (a replay: the tab its document was read from; the URL names it unless first).
  const tabId = fake ? (rp && fake.tabs.some((t) => t.id === rp.tabId) ? rp.tabId : fake.tabs[0].id) : null;
  if (fake && tabId !== fake.tabs[0].id) docTab.url += `?tab=${encodeURIComponent(tabId)}`;
  if (rp && rp.docInstructions) env.storage[T.docInstructionsKey('DOC123')] = rp.docInstructions;
  if (rp && rp.mainInstructions) env.storage[T.MAIN_INSTRUCTIONS_KEY] = rp.mainInstructions;
  // A second, keyed Munin account only for the cases that require it, so the other cases keep the provider's tool set.
  const munin = (c.requires || []).includes('munin-key');
  setAccounts(state, provider, opts.apiKey || (dry ? 'dry-key' : ''), munin ? opts.muninKey || (dry ? 'dry-key' : '') : '', opts.model, opts.server);
  state.applyMode = applyModeOf(c.mode);
  await T.refreshContext({ force: true });
  await T.createChat();
  // A two-turn case without a second run: the chat's earlier messages (case.history: [{ role, content }]) before the
  // run's first message; a replay: the saved chat's messages before it, as they were stored.
  // Stored too: the turn starts from the stored history (readChatForTurn), which would otherwise drop them.
  for (const m of c.history || []) state.messages.push({ role: m.role, content: m.content });
  for (const m of rp ? rp.messages : []) state.messages.push(JSON.parse(JSON.stringify(m)));
  if ((c.history || []).length || (rp && rp.messages.length)) await T.saveHistory();

  const requests = [];
  const script = dry ? dryScript(c, opts.runIndex || 0) : null;
  let turnNo = 0;
  let turnRequests = 0;
  let seq = 0;
  const ids = () => `dry_${++seq}`;
  const sideUsage = { prompt: 0, completion: 0 };
  const sideReads = [];
  const providerFetch = async (url, init) => {
    // The search tool (src/munin-search.js) calls Munin's /api routes, not the chat API: no tokens and no script round.
    // Dry, it gets the case's drySearch (Munin's JSON: { papers } or { documents }); live, the real search.
    if (/\/api\/(search\/hybrid|retrieve)$/.test(String(url))) {
      if (!dry) return (opts.fetchImpl || fetch)(url, init);
      return new Response(JSON.stringify(c.drySearch || { papers: [], documents: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const body = init && typeof init.body === 'string' ? init.body : '';
    // A Custom account's model list (GET /models): no tokens and no round; dry, the run's model and a sibling.
    if (custom && !body && /\/models$/.test(String(url))) {
      if (!dry) return (opts.fetchImpl || fetch)(url, init);
      return new Response(JSON.stringify(dryModelList(opts.model)), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    // Dry, a request without a body is a lookup (Crossref, OpenAlex, Zotero after an allowed access card): found nothing.
    if (dry && !body) return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    const side = sideRequest(body);
    requests.push({ chars: body.length, turn: turnNo, side });
    if (!dry) {
      const res = await (opts.fetchImpl || fetch)(url, init);
      // A side request's tokens are spent but stored nowhere in the chat: read them from a copy of its stream.
      if (side && res && typeof res.clone === 'function') {
        sideReads.push(res.clone().text().then((t) => { const u = streamUsage(t); sideUsage.prompt += u.prompt; sideUsage.completion += u.completion; }).catch(() => {}));
      }
      return res;
    }
    const est = Math.round(body.length / CHARS_PER_TOKEN);
    if (side) return sseResponse(ROUND_BUILDERS[provider]({ text: 'OK' }, ids, est));
    const rounds = turnRounds(script, turnNo);
    const round = rounds[Math.min(turnRequests++, rounds.length - 1)];
    return sseResponse(ROUND_BUILDERS[provider](round, ids, est));
  };
  const route = async (url, init) => (fake && (await fake.fetch(url, init))) || providerFetch(url, init);
  ctx.fetch = c.docsApi ? route : tabExportOnly(route);
  // As after Check provider: the list gives the Custom account its model id prefix (the body then gets the full id).
  if (custom) {
    const a = state.settings.accounts.find((x) => x.type === 'custom');
    try { await T.fetchAndCacheModels(a); } catch (e) { errors.push(`model list: ${String(e && e.message || e).slice(0, 200)}`); }
  }
  const startText = rp ? (fake ? (await T.fetchDocModel('DOC123', tabId)).text : doc.text) : null;

  // The user at the cards: the turn's scripted decisions (cardDecision). An allowed access card stands for the user's
  // Allow and Chrome's grant (the click's chrome.permissions.request cannot run here).
  const cards = [];
  let turn = null;
  const decider = setInterval(() => {
    if (!turn) return;
    for (const [id, p] of T.pendingPreviews) {
      const html = String(p.card && p.card.innerHTML || '');
      const cls = String(p.card && p.card.className || '');
      const kind = /\bask\b/.test(cls) ? 'ask' : /\baccess\b/.test(cls) ? 'access' : html.includes('open_document') ? 'open' : 'edit';
      const given = cardDecision(kind, turn, cards.filter((x) => x.turn === turnNo && x.kind === kind).length);
      const decision = kind === 'ask' ? askDecision(given, html) : given;
      if (kind === 'access' && decision === 'accept') state.settings.references = true;
      cards.push({ turn: turnNo, kind, decision });
      T.decidePreview(id, decision);
    }
  }, 10);
  const turns = [];
  try {
    for (const [t, spec] of caseTurns(c, prompt, opts.paraphrase || 0).entries()) {
      turn = spec;
      turnNo = t;
      turnRequests = 0;
      doc.selection = spec.selection || '';
      state.applyMode = applyModeOf(spec.mode);
      const before = state.messages.length;
      const errorsBefore = errors.length;
      const rowsBefore = rows.length;
      const timeout = setTimeout(() => { if (state.abort) state.abort.abort(); }, opts.timeoutMs || (dry ? 20000 : 240000));
      let outcome;
      try {
        T.el.input.value = spec.prompt;
        outcome = await T.startTurn(null);
      } finally {
        clearTimeout(timeout);
      }
      // A side question's exchange is on the side thread (its user message holds the text after "/side"), not in the chat.
      const ask = T.parseSlashCommand(spec.prompt);
      const all = JSON.parse(JSON.stringify(ask.side ? state.sideMessages : state.messages));
      // The message's own part of the history: from its user message (the stored history may have been re-read; the side
      // thread may have started anew with this question: its last such message).
      let at = ask.side ? all.map((m) => m.role === 'user' && !m._auto && m.content === ask.text).lastIndexOf(true)
        : all.findIndex((m, i) => i >= Math.min(before, all.length - 1) && m.role === 'user' && !m._auto && m.content === spec.prompt);
      if (at < 0) at = ask.side ? all.length : before;
      const messages = all.slice(at);
      const finalModel = fake ? await T.fetchDocModel('DOC123', tabId) : null;
      // the formatting view as read_document shows it (Normal text's font read when a run sets a font)
      if (finalModel) await T.knowUnmarkedFont({ model: finalModel, docFormat: 'docs-api' });
      turns.push({
        ...trajectory(messages, t), outcome, expect: spec.expect, prompt: spec.prompt,
        errors: errors.slice(errorsBefore), rows: rows.slice(rowsBefore),
        finalText: finalModel ? finalModel.text : doc.text,
        // The document's formatting after the message in the reading notation ({text}(bg=#00B050), **bold**), one line per paragraph.
        finalFormatting: finalModel ? finalModel.lines.map((l) => T.markedText(l, T.spanDefault(finalModel))).join('\n') : '',
        lines: fake ? docLines(fake.mirror ? await fake.mirror() : fake, tabId) : null,
        cards: cards.filter((x) => x.turn === t), requests: requests.filter((r) => r.turn === t), messages,
      });
      if (outcome !== 'done') break; // a failed message ends the chat: its later messages would test nothing
    }
  } finally {
    clearInterval(decider);
  }
  await Promise.all(sideReads);
  const last = turns[turns.length - 1];
  const usage = { prompt: 0, completion: 0 };
  for (const x of turns) { usage.prompt += x.usage.prompt; usage.completion += x.usage.completion; }
  return {
    outcome: (turns.find((x) => x.outcome !== 'done') || last).outcome, errors, rows,
    calls: turns.flatMap((x) => x.calls), rounds: turns.flatMap((x) => x.rounds), answer: last.answer, usage, results: turns.flatMap((x) => x.results),
    finalText: last.finalText, finalFormatting: last.finalFormatting, lines: last.lines,
    requests, cards, messages: turns.flatMap((x) => x.messages), turns, sideUsage, ...(rp ? { startText } : {}),
  };
}

// The calls of a message's part of the history, with their results: { calls, rounds, answer, usage, results }.
// results: the full texts of the tool results the model saw, in order.
function trajectory(messages, turn = 0) {
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
      calls.push({ name: tc.function.name, args, ok: !!(r && r._ok), round: rounds.length, turn, content: r ? String(r.content).slice(0, 160) : '(no result)' });
      names.push(tc.function.name);
    }
    rounds.push(names);
  }
  const texts = messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
  return { calls, rounds, answer, usage, results: texts };
}
// The verbose answer of a run whose responses hold no text: what its last response held, so a model that ended its turn
// without a word (the panel then shows no answer, only the edit rows) is told apart from text the harness missed.
function noAnswerNote(run) {
  const last = [...(run.messages || [])].reverse().find((m) => m.role === 'assistant');
  if (!last) return '(no model response)';
  const u = last._usage || {};
  return `(no text in any response; the last: ${(last.tool_calls || []).length} calls, ${Number(u.completion_tokens) || 0} completion tokens`
    + `${u.reasoning_tokens ? ` (${u.reasoning_tokens} reasoning)` : ''}${last._reasoning ? ', a reasoning summary' : ''})`;
}

// A run's trajectory as one string, for the flip rate: responses separated by " | ", failed calls marked "!", the
// messages of a chat by " || ".
function trajectoryKey(run) {
  return (run.turns || [run]).map((x) => {
    const rounds = [];
    for (const c of x.calls) (rounds[c.round] = rounds[c.round] || []).push(c.name + (c.ok ? '' : '!'));
    return rounds.map((r) => (r || []).join('+')).join(' | ');
  }).join(' || ');
}

// ---- Expectations ---------------------------------------------------------------------------------------------------
// expect (per message): order: ["a|b", ...] (successful calls, in this order, others may come between), forbid: [name |
// "write"] (never called, even if refused), alone: [name] (the only call of its response), max / min: { name | "write":
// n } (max: calls, any outcome; min: successful calls), failedMax: n (calls that failed or were refused), roundsMax: n
// (model responses), cardsMax: { access | edit | ask | open: n }, args / argsNot: { name: regex } (some / no call of the
// tool has arguments, as JSON, that match), results / resultsNot: regex on the tool results the model saw,
// finalText / finalTextNot / answer / answerNot: regex sources (flags iu) on the document after the message / the final
// answer, finalFormatting / finalFormattingNot: on the document's formatting (Docs API cases: the reading notation, see
// runOnce), answerLang: "ru" | "en" (the answer outside edit blocks is mostly in that script), answerOutsideMax: n
// (characters of the answer outside <replacement> / <insertion> blocks), noRefusal: true (the answer does not refuse:
// REFUSAL_RE), lines: [{ match (regex, the first line it matches; nth: the n-th) | line (1-based), text, textNot, style,
// indent: [start, firstLine], indentLike (regex: the same effective indent as that line, see docLines),
// ownIndent (null: none of its own, or [start, firstLine]), spaceAbove, spaceBelow, size (pt, ±0.6), bold, italic,
// listLevel (null: not a list item), numbered }] on the document's lines after the message (docLines; Docs API cases), sameList: [regex, …] (the
// lines they match are items of one list). A message also fails when it did not end normally, and on the transcript
// graders of defect-bench.js.
const expand = (name) => (name === 'write' ? WRITE_TOOLS : [name]);
// A final answer that tells the user the request cannot be done (a user-visible refusal; English and Russian).
const REFUSAL_RE = /\b(?:I (?:can ?not|can't|cannot|am (?:not able|unable) to|won't|am not allowed to)|(?:is|are) not allowed|not permitted|unable to (?:insert|add|apply|make|edit|change))\b|не могу|не получится|не удалось (?:вставить|внести|добавить|изменить)|нельзя|не разрешено|запрещен/iu;
const EDIT_BLOCK_RE = /<(replacement|insertion)>[\s\S]*?<\/\1>/g;
const outsideBlocks = (answer) => String(answer || '').replace(EDIT_BLOCK_RE, ' ').trim();
// "ru" when Cyrillic letters outnumber Latin ones in the answer outside edit blocks, else "en" ('' without letters).
function answerLang(answer) {
  const t = outsideBlocks(answer);
  const cyr = (t.match(/[А-Яа-яЁё]/g) || []).length;
  const lat = (t.match(/[A-Za-z]/g) || []).length;
  return !cyr && !lat ? '' : cyr > lat ? 'ru' : 'en';
}
const near = (a, b) => a != null && b != null && Math.abs(a - b) <= 0.6;
const fmtIndent = (v) => v.map((x) => (x == null ? '–' : +x.toFixed(2))).join('/');
const sameIndent = (a, b) => near(a[0], b[0]) && near(a[1], b[1]);
// The failures of one lines expectation against the document's lines.
function lineFailures(want, lines) {
  const re = (s) => new RegExp(s, 'iu');
  const label = want.match ? `line /${want.match}/${want.nth ? ` #${want.nth}` : ''}` : `line ${want.line}`;
  let l;
  if (want.match) l = lines.filter((x) => re(want.match).test(x.text))[(want.nth || 1) - 1];
  else l = lines[want.line - 1];
  if (!l) return [`${label}: not in the document`];
  const out = [];
  // indentLike: the same effective indent (the one Docs draws, see docLines) as another line: inheriting like that line,
  // or the same values of its own, passes.
  if (want.indentLike) {
    const o = lines.find((x) => re(want.indentLike).test(x.text));
    if (!o) out.push(`${label}: no line /${want.indentLike}/ to compare the indent with`);
    else if (!sameIndent(l.indent, o.indent)) out.push(`${label}: indent ${fmtIndent(l.indent)} pt, line /${want.indentLike}/ has ${fmtIndent(o.indent)}`);
  }
  if (want.ownIndent !== undefined) {
    const ok = want.ownIndent === null ? l.ownIndent === null : !!l.ownIndent && sameIndent(l.ownIndent, want.ownIndent);
    if (!ok) out.push(`${label}: own indent ${l.ownIndent ? fmtIndent(l.ownIndent) + ' pt' : 'none'}, expected ${want.ownIndent ? fmtIndent(want.ownIndent) + ' pt' : 'none'}`);
  }
  if (want.text && !re(want.text).test(l.text)) out.push(`${label}: text does not match /${want.text}/`);
  if (want.textNot && re(want.textNot).test(l.text)) out.push(`${label}: text matches /${want.textNot}/`);
  if (want.style && String(l.style).toLowerCase().replace('heading_', 'h') !== String(want.style).toLowerCase().replace('heading_', 'h')) out.push(`${label}: style ${l.style}, expected ${want.style}`);
  if (want.indent && !(near(l.indent[0], want.indent[0]) && near(l.indent[1], want.indent[1]))) out.push(`${label}: indent ${fmtIndent(l.indent)} pt, expected ${fmtIndent(want.indent)}`);
  for (const k of ['spaceAbove', 'spaceBelow', 'size']) if (want[k] != null && !near(l[k], want[k])) out.push(`${label}: ${k} ${l[k]}, expected ${want[k]}`);
  for (const k of ['bold', 'italic', 'numbered']) if (want[k] != null && l[k] !== want[k]) out.push(`${label}: ${k} ${l[k]}, expected ${want[k]}`);
  if (want.listLevel !== undefined && l.listLevel !== want.listLevel) out.push(`${label}: list level ${l.listLevel}, expected ${want.listLevel}`);
  return out;
}
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
  for (const [name, n] of Object.entries(expect.min || {})) {
    const count = run.calls.filter((c) => c.ok && expand(name).includes(c.name)).length;
    if (count < n) failures.push(`${name} succeeded ${count} times (min ${n})`);
  }
  if (expect.failedMax != null) {
    const failed = run.calls.filter((c) => !c.ok);
    if (failed.length > expect.failedMax) failures.push(`${failed.length} failed or refused calls (max ${expect.failedMax}): ${failed.map((c) => c.name).join(', ')}`);
  }
  if (expect.roundsMax != null) {
    const responses = run.requests ? run.requests.filter((r) => !r.side).length : run.rounds.length + 1;
    if (responses > expect.roundsMax) failures.push(`${responses} responses (max ${expect.roundsMax})`);
  }
  for (const [kind, n] of Object.entries(expect.cardsMax || {})) {
    const count = (run.cards || []).filter((x) => x.kind === kind).length;
    if (count > n) failures.push(`${count} ${kind} cards (max ${n})`);
  }
  const re = (s) => new RegExp(s, 'iu');
  for (const [name, s] of Object.entries(expect.args || {})) {
    if (!run.calls.some((c) => c.name === name && re(s).test(JSON.stringify(c.args)))) failures.push(`no ${name} call with arguments matching /${s}/`);
  }
  for (const [name, s] of Object.entries(expect.argsNot || {})) {
    if (run.calls.some((c) => c.name === name && re(s).test(JSON.stringify(c.args)))) failures.push(`${name} arguments match /${s}/`);
  }
  const results = (run.results || []).join('\n');
  if (expect.results && !re(expect.results).test(results)) failures.push(`results do not match /${expect.results}/`);
  if (expect.resultsNot && re(expect.resultsNot).test(results)) failures.push(`results match /${expect.resultsNot}/`);
  if (expect.finalText && !re(expect.finalText).test(run.finalText)) failures.push(`document does not match /${expect.finalText}/`);
  if (expect.finalTextNot && re(expect.finalTextNot).test(run.finalText)) failures.push(`document matches /${expect.finalTextNot}/`);
  if (expect.finalFormatting && !re(expect.finalFormatting).test(run.finalFormatting || '')) failures.push(`formatting does not match /${expect.finalFormatting}/`);
  if (expect.finalFormattingNot && re(expect.finalFormattingNot).test(run.finalFormatting || '')) failures.push(`formatting matches /${expect.finalFormattingNot}/`);
  if (expect.answer && !re(expect.answer).test(run.answer)) failures.push(`answer does not match /${expect.answer}/`);
  if (expect.answerNot && re(expect.answerNot).test(run.answer)) failures.push(`answer matches /${expect.answerNot}/`);
  if (expect.answerLang && answerLang(run.answer) !== expect.answerLang) failures.push(`answer language ${answerLang(run.answer) || 'none'}, expected ${expect.answerLang}`);
  if (expect.answerOutsideMax != null && outsideBlocks(run.answer).length > expect.answerOutsideMax) failures.push(`answer outside edit blocks has ${outsideBlocks(run.answer).length} characters (max ${expect.answerOutsideMax})`);
  if (expect.noRefusal && REFUSAL_RE.test(run.answer)) failures.push(`answer refuses ("${(REFUSAL_RE.exec(run.answer) || [''])[0]}")`);
  if (expect.lines || expect.sameList) {
    if (!run.lines) failures.push('lines expected, but the case has no Docs API document');
    else {
      for (const w of expect.lines || []) failures.push(...lineFailures(w, run.lines));
      if (expect.sameList) {
        const ls = expect.sameList.map((s) => run.lines.find((x) => re(s).test(x.text)));
        const ids = new Set(ls.map((x) => (x ? x.listId : null)));
        if (ls.some((x) => !x || !x.listId) || ids.size > 1) failures.push(`lines /${expect.sameList.join('/, /')}/ are not items of one list`);
      }
    }
  }
  // The transcript graders of the defect benchmark: a write after a check-only request, a claimed check without a read.
  for (const g of gradeTranscript(run.messages || [])) {
    if (!g.rewrote.pass) failures.push(`rewrote when only asked to check (${[...g.rewrote.writes, g.rewrote.block ? 'edit block' : ''].filter(Boolean).join(', ')})`);
    if (!g.claimed.pass) failures.push(`claimed a check without reading ("${g.claimed.claim}")`);
  }
  return { pass: !failures.length, failures };
}
// A whole run: each message against its own expect (the first: the case's), failures prefixed "message N: " when the
// case has later messages. A message the chat never reached (an earlier one failed) fails as not run.
function evaluateRun(c, run) {
  const specs = [c.expect || {}, ...(c.turns || []).map((t) => t.expect || {})];
  if (!run.turns || specs.length === 1) return evaluate(c.expect, run);
  const failures = [];
  specs.forEach((expect, t) => {
    const x = run.turns[t];
    if (!x) { failures.push(`message ${t + 1}: not sent (an earlier message failed)`); return; }
    for (const f of evaluate(expect, x).failures) failures.push(`message ${t + 1}: ${f}`);
  });
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
// The cost and effort of one run: tool calls, failed or refused calls, model responses (the panel's own side requests
// left out), prompt and completion tokens, and user-visible refusals (messages whose final answer matches REFUSAL_RE).
function runMetrics(run) {
  const turns = run.turns || [run];
  return {
    calls: run.calls.length, failed: run.calls.filter((c) => !c.ok).length,
    rounds: (run.requests || []).filter((r) => !r.side).length,
    prompt: run.usage.prompt, completion: run.usage.completion,
    refusals: turns.filter((x) => REFUSAL_RE.test(x.answer || '')).length,
  };
}
const METRIC_KEYS = ['calls', 'failed', 'rounds', 'prompt', 'completion', 'refusals'];
// A case's numbers from its runs ([{ paraphrase, pass, run }]): pass rate, flip rate (mean over paraphrases), error rate
// (the turn failed or stopped), degraded rate (a call failed or was refused), recovery rate (degraded runs that still
// passed), tokens, and the sums of runMetrics (metrics; divide by runs for the mean per run).
function caseStats(runs) {
  const n = runs.length;
  const by = new Map();
  for (const r of runs) { if (!by.has(r.paraphrase)) by.set(r.paraphrase, []); by.get(r.paraphrase).push(r); }
  const flips = [...by.values()].filter((l) => l.length > 1).map((l) => flipRate(l.map((r) => trajectoryKey(r.run))));
  const degraded = runs.filter((r) => r.run.outcome === 'done' && r.run.calls.some((c) => !c.ok));
  const metrics = Object.fromEntries(METRIC_KEYS.map((k) => [k, 0]));
  for (const r of runs) { const m = runMetrics(r.run); for (const k of METRIC_KEYS) metrics[k] += m[k]; }
  return {
    runs: n,
    passed: runs.filter((r) => r.pass).length,
    perParaphrase: [...by.entries()].map(([p, l]) => ({ paraphrase: p, passed: l.filter((r) => r.pass).length, runs: l.length })),
    flipRate: flips.length ? flips.reduce((a, b) => a + b, 0) / flips.length : 0,
    errorRate: n ? runs.filter((r) => r.run.outcome !== 'done').length / n : 0,
    degradedRate: n ? degraded.length / n : 0,
    degraded: degraded.length,
    recovered: degraded.filter((r) => r.pass).length,
    tokens: runs.reduce((t, r) => t + runTokens(r.run), 0),
    requests: runs.reduce((t, r) => t + r.run.requests.length, 0),
    metrics,
  };
}

// ---- The eval ---------------------------------------------------------------------------------------------------------
// cases: the case list; opts: { provider, model, apiKey, muninKey, dry, repeats (3), budget (tokens; runs stop starting
// once the recorded usage passes it), paraphrases (indices to run, default all), met ({ requirement: bool }: a case with
// an unmet requirement is skipped, its entry carries `unmet` and no runs; without met, requirements are ignored: the
// dry run), onRun(info) }. Returns { cases: [{ id, unmet?, stats, runs: [{ paraphrase, repeat, pass, failures,
// trajectory, outcome, tokens, metrics, requestChars, cards }] }], tokens, skipped }.
async function runEval(cases, opts) {
  const repeats = opts.repeats || 3;
  const out = { cases: [], tokens: 0, skipped: 0 };
  for (const c of cases) {
    const unmet = opts.met ? unmetRequirements(c, opts.met) : [];
    if (unmet.length) { out.cases.push({ id: c.id, unmet, stats: caseStats([]), runs: [] }); continue; }
    const runs = [];
    const prompts = c.prompts.map((p, i) => [i, p]).filter(([i]) => !opts.paraphrases || opts.paraphrases.includes(i));
    let k = 0;
    for (const [pi, prompt] of prompts) {
      for (let rep = 0; rep < repeats; rep++, k++) {
        if (opts.budget && out.tokens >= opts.budget) { out.skipped++; continue; }
        const run = await runOnce(c, prompt, { ...opts, runIndex: k, paraphrase: pi });
        const verdict = evaluateRun(c, run);
        const tokens = runTokens(run);
        out.tokens += tokens;
        runs.push({ paraphrase: pi, repeat: rep, ...verdict, run });
        if (opts.onRun) {
          opts.onRun({ case: c.id, paraphrase: pi, repeat: rep, pass: verdict.pass, failures: verdict.failures, trajectory: trajectoryKey(run), tokens, metrics: runMetrics(run),
            // the results as the model saw them in the turn (a reading result is folded after it; _log keeps the text)
            calls: run.calls.map((x) => ({ name: x.name, args: x.args, ok: x.ok })), answer: run.answer || noAnswerNote(run),
            results: run.messages.filter((m) => m.role === 'tool').map((m) => String(typeof m._log === 'string' ? m._log : m.content)) });
        }
      }
    }
    out.cases.push({
      id: c.id, stats: caseStats(runs),
      runs: runs.map((r) => ({ paraphrase: r.paraphrase, repeat: r.repeat, pass: r.pass, failures: r.failures, trajectory: trajectoryKey(r.run),
        outcome: r.run.outcome, tokens: runTokens(r.run), metrics: runMetrics(r.run),
        requestChars: r.run.requests.map((q) => q.chars), cards: r.run.cards })),
    });
  }
  return out;
}

// The case file: { docs?: { name: lines }, cases: [...] } or a list. Each case needs a unique id, prompts (one or more)
// and a doc (lines, or "@name" of docs) or a fixture (a path from the checkout root); requires names REQUIREMENTS only;
// a later message (turns) needs a prompt or prompts; a line given as an object (a fake-docs item) needs docsApi.
function loadCases(file = CASES_FILE) {
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
    if (doc && doc.some((l) => l && typeof l === 'object') && !c.docsApi) throw new Error(`case ${c.id}: formatted lines need docsApi`);
    const text = doc ? doc.map(plainLine).join('\n') : '';
    for (const sel of [c.selection, ...(c.turns || []).map((t) => t.selection)]) {
      if (sel && doc && !text.includes(sel)) throw new Error(`case ${c.id}: the selection is not in the document`);
    }
    for (const [i, t] of (c.turns || []).entries()) {
      if (!t.prompt && !(Array.isArray(t.prompts) && t.prompts.length)) throw new Error(`case ${c.id}: message ${i + 2} has no prompt`);
    }
    const unknown = (c.requires || []).filter((r) => !REQUIREMENTS[r]);
    if (unknown.length) throw new Error(`case ${c.id}: unknown requirement ${unknown.join(', ')} (known: ${Object.keys(REQUIREMENTS).join(', ')})`);
    return { ...c, doc };
  });
}

// The named case sets of the file ({ sets: { name: [ids] } }; the runner's --set): every id must be a case.
function loadSets(file = CASES_FILE) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const sets = (!Array.isArray(data) && data.sets) || {};
  const ids = new Set(loadCases(file).map((c) => c.id));
  for (const [name, list] of Object.entries(sets)) {
    const unknown = list.filter((id) => !ids.has(id));
    if (unknown.length) throw new Error(`set ${name}: unknown case ${unknown.join(', ')}`);
  }
  return sets;
}

// ---- Replay of a bug bundle (src/chat-log.js buildBugBundle; development/tools/tool-eval.js --replay) ------------------
// A bundle turn becomes a one-message case (replayCase): its document (the documents.get body on the fake Docs server,
// or the export text on the fake tab), the chat history before it as stored, its mode, selection and instructions, the
// user's message, the cards answered as the saved chat answered them (savedCards; else the eval's defaults) and, for the
// dry run, the saved chat's own responses of that turn as the recorded rounds (savedRounds). An expect (the case format:
// the turn's own, else the bundle's) is checked when present. Bundles hold real document text: they are read from
// wherever they are and never copied.
const BUNDLE_KIND = 'munin-bug-bundle';
const BUNDLE_VERSION = 1;
function loadBundle(file) {
  const b = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!b || b.kind !== BUNDLE_KIND || !Array.isArray(b.messages) || !Array.isArray(b.turns)) throw new Error(`${file}: not a bug bundle (Alt+click on a chat's copy button saves one).`);
  if (!(b.version <= BUNDLE_VERSION)) throw new Error(`${file}: bundle version ${b.version}; this checkout reads version ${BUNDLE_VERSION} and older.`);
  return b;
}
// The 0-based turns a selector names: "N" (1-based), "a-b", "all"; null or '' is the last turn. Throws on a bad one.
function bundleTurnIndices(bundle, sel) {
  const n = bundle.turns.length;
  if (!n) throw new Error('The bundle has no turns.');
  const s = String(sel == null ? '' : sel).trim();
  if (!s) return [n - 1];
  if (s === 'all') return bundle.turns.map((_, i) => i);
  const m = /^(\d+)(?:-(\d+))?$/.exec(s);
  const a = m ? Number(m[1]) : 0;
  const b = m && m[2] ? Number(m[2]) : a;
  if (!m || a < 1 || b < a || b > n) throw new Error(`No turn ${s}: the bundle has turns 1-${n}.`);
  return Array.from({ length: b - a + 1 }, (_, i) => a - 1 + i);
}
// The stored messages of turn n: from its user message to the next turn's.
function bundleTurnMessages(bundle, n) {
  const next = bundle.turns[n + 1];
  return bundle.messages.slice(bundle.turns[n].message, next ? next.message : bundle.messages.length);
}
const parsedArgs = (tc) => { try { return JSON.parse((tc.function && tc.function.arguments) || '{}') || {}; } catch (e) { return {}; } };
// The saved chat's responses of a turn as recorded rounds (one per assistant message: its calls, else its text).
const savedRounds = (msgs) => msgs.filter((m) => m && m.role === 'assistant').map((m) => (Array.isArray(m.tool_calls) && m.tool_calls.length
  ? { calls: m.tool_calls.map((tc) => [tc.function.name, parsedArgs(tc)]) } : { text: String(m.content || '') }));
// The saved chat's answers to its cards (the tool results' _answered, src/gate.js answerCard), as a case's cards in the
// order shown: edit allow | allow-all | deny (Deny and Stop), open allow | deny, access allow | not-now, ask "answers:<JSON>"
// (a stopped question is left to the default).
const SAVED_CARD = { edit: { accept: 'allow', 'accept-all': 'allow-all' }, open: { accept: 'allow', 'accept-all': 'allow' }, access: { accept: 'allow' } };
const SAVED_CARD_NO = { edit: 'deny', open: 'deny', access: 'not-now' };
function savedCards(msgs) {
  const out = {};
  for (const m of msgs) {
    for (const a of m && m.role === 'tool' && Array.isArray(m._answered) ? m._answered : []) {
      if (!a || !a.kind) continue;
      let d = null;
      if (a.kind === 'ask') {
        const answers = Array.isArray(a.questions) ? a.questions.map((q) => (q && q.answer) || '') : typeof a.choice === 'string' ? [a.choice] : null;
        if (a.decision !== 'option' || !answers) continue;
        d = 'answers:' + JSON.stringify(answers);
      } else if (SAVED_CARD_NO[a.kind]) d = SAVED_CARD[a.kind][a.decision] || SAVED_CARD_NO[a.kind];
      else continue;
      (out[a.kind] = out[a.kind] || []).push(d);
    }
  }
  return out;
}
// Why turn n cannot be replayed, or ''.
function unreplayable(bundle, n) {
  const t = bundle.turns[n];
  const m = bundle.messages[t.message] || {};
  if (m._agentReport) return 'an agents\' report turn (the panel sends it, not the user)';
  if (!t.kept) return 'not kept by the panel (its document and start are unknown)';
  if (t.document == null || !bundle.documents[t.document]) return t.documentNote || 'its document is not in the bundle';
  return '';
}
// Turn n of a bundle as a case for runOnce (see the section head).
function replayCase(bundle, n) {
  const t = bundle.turns[n];
  const user = bundle.messages[t.message] || {};
  const msgs = bundleTurnMessages(bundle, n);
  const doc = bundle.documents[t.document] || null;
  const persona = typeof user._persona === 'string' && user._persona ? user._persona : '';
  const mode = String(t.mode || (user._asks ? 'manual' : user._mode) || '');
  return {
    id: `turn ${n + 1}`, mode: mode === 'manual' || mode === 'plan' ? mode : 'auto', docsApi: !!doc && doc.format === 'docs-api',
    // The saved turn was offered Munin's search tool: the replay needs a keyed Munin account too (MUNIN_API_KEY on another provider).
    ...((t.tools || []).includes('search') ? { requires: ['munin-key'] } : {}),
    prompts: [(persona ? `/${persona} ` : '') + String(user.content || '')], selection: (t.selection && t.selection.text) || '',
    cards: savedCards(msgs), dry: [savedRounds(msgs)], expect: t.expect || bundle.expect || null,
    replay: {
      body: doc && doc.format === 'docs-api' ? doc.body : null, tabId: (doc && doc.tabId) || null,
      exportText: doc && doc.format !== 'docs-api' ? String(doc.text || '') : '', exportFormat: doc ? doc.format : 'text',
      messages: bundle.messages.slice(0, t.message), docInstructions: t.docInstructions || '', mainInstructions: t.mainInstructions || '',
    },
  };
}
// The calls of a turn's messages with the full results the model saw: [{ round, name, args, status ('ok' | 'failed' |
// 'refused', as the eval counts: ok only with _ok), result }].
function callReports(messages) {
  const results = new Map((messages || []).filter((m) => m && m.role === 'tool').map((m) => [m.tool_call_id, m]));
  const out = [];
  let round = 0;
  for (const m of messages || []) {
    if (!m || m.role !== 'assistant' || !Array.isArray(m.tool_calls) || !m.tool_calls.length) continue;
    for (const tc of m.tool_calls) {
      const r = results.get(tc.id);
      const text = r ? String(typeof r._log === 'string' ? r._log : r.content == null ? '' : r.content) : '(no result)';
      const status = r && (r._decision === 'rejected' || r._decision === 'stopped' || /^Refused\b/.test(text)) ? 'refused' : r && r._ok ? 'ok' : 'failed';
      out.push({ round, name: tc.function.name, args: parsedArgs(tc), status, result: text });
    }
    round++;
  }
  return out;
}
// The changed lines from before to after: "- L<n>: old" (its line before), "+ L<n>: new" (its line after), in order;
// [] when equal. The common start and end are skipped; a middle beyond 4 million line pairs is shown as removed, then added.
function lineDiff(before, after) {
  const a = String(before == null ? '' : before).split('\n');
  const b = String(after == null ? '' : after).split('\n');
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  const A = a.slice(p, a.length - q);
  const B = b.slice(p, b.length - q);
  const del = (i) => `- L${p + i + 1}: ${A[i]}`;
  const add = (j) => `+ L${p + j + 1}: ${B[j]}`;
  if (A.length * B.length > 4e6) return [...A.map((_, i) => del(i)), ...B.map((_, j) => add(j))];
  // The longest common subsequence of the middles (L[i][j]: from A[i] and B[j] on), then the walk through it.
  const W = B.length + 1;
  const L = new Uint32Array((A.length + 1) * W);
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) L[i * W + j] = A[i] === B[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < A.length || j < B.length) {
    // On a tie the removed line comes first (an old line, then the line that replaced it).
    if (i < A.length && j < B.length && A[i] === B[j]) { i++; j++; } else if (j < B.length && (i === A.length || L[i * W + j + 1] > L[(i + 1) * W + j])) out.push(add(j++));
    else out.push(del(i++));
  }
  return out;
}
const hasExpect = (e) => !!e && typeof e === 'object' && Object.keys(e).length > 0;
// Replays turns (0-based indices) of a bundle on the current code: per turn its saved side (from the stored messages)
// and one report per run. opts as runEval's: { provider, model, apiKey, muninKey, dry, repeats (default 1), budget,
// timeoutMs, root, fetchImpl, onRun(info) }. Returns { turns: [{ turn (1-based), prompt, mode, document ('docs-api' |
// 'markdown' | 'text'), tabId, selection, files, skipped (why not replayed), saved: { provider, providerType, model,
// calls, answer, metrics }, runs: [{ outcome, errors, rows, calls, answer, diff, metrics, tokens, trajectory, cards,
// pass?, failures? }] }], tokens, skipped (runs over the budget) }.
async function runReplay(bundle, turns, opts = {}) {
  const out = { turns: [], tokens: 0, skipped: 0 };
  for (const n of turns) {
    const t = bundle.turns[n];
    const user = bundle.messages[t.message] || {};
    const msgs = bundleTurnMessages(bundle, n);
    const doc = t.document != null ? bundle.documents[t.document] : null;
    const saved = trajectory(msgs);
    const entry = {
      turn: n + 1, prompt: String(user.content || ''), mode: String(t.mode || user._mode || ''), document: doc ? doc.format : null, tabId: (doc && doc.tabId) || null,
      selection: (t.selection && t.selection.text) || '', files: [...(Array.isArray(user._files) ? user._files.map((f) => (f && (f.title || f.alias)) || '') : []), ...(t.files || []).map((f) => f.title || f.alias)],
      saved: { provider: t.provider || '', providerType: t.providerType || '', model: t.model || '', calls: callReports(msgs), answer: saved.answer,
        metrics: { calls: saved.calls.length, failed: saved.calls.filter((c) => !c.ok).length, rounds: msgs.filter((m) => m.role === 'assistant').length,
          prompt: saved.usage.prompt, completion: saved.usage.completion } },
      runs: [],
    };
    const why = unreplayable(bundle, n);
    if (why) { entry.skipped = why; out.turns.push(entry); continue; }
    const c = replayCase(bundle, n);
    for (let rep = 0; rep < (opts.repeats || 1); rep++) {
      if (opts.budget && out.tokens >= opts.budget) { out.skipped++; continue; }
      const run = await runOnce(c, c.prompts[0], { ...opts, runIndex: 0, paraphrase: 0 });
      const x = run.turns[0] || run;
      const tokens = runTokens(run);
      out.tokens += tokens;
      const verdict = hasExpect(c.expect) ? evaluate(c.expect, x) : null;
      const r = { outcome: run.outcome, errors: run.errors, rows: run.rows, calls: callReports(x.messages), answer: x.answer, diff: lineDiff(run.startText, x.finalText),
        metrics: runMetrics(run), tokens, trajectory: trajectoryKey(run), cards: run.cards, ...(verdict ? { pass: verdict.pass, failures: verdict.failures } : {}) };
      entry.runs.push(r);
      if (opts.onRun) opts.onRun({ turn: n + 1, repeat: rep, ...r });
    }
    out.turns.push(entry);
  }
  return out;
}

// ---- The replay as text (the runner prints it) -----------------------------------------------------------------------
const REPLAY_RESULT_CHARS = 1500;
const REPLAY_COLUMN = 56;
const fit = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));
const callLine = (c) => `${c.name}(${JSON.stringify(Object.fromEntries(Object.entries(c.args || {}).filter(([, v]) => v != null)))})${c.status === 'ok' ? '' : ' ' + c.status.toUpperCase()}`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const metricsLine = (m, tokens) => `${plural(m.calls, 'call')}, ${m.failed} failed or refused, ${plural(m.rounds, 'round')}` + (tokens != null ? `, ${tokens.toLocaleString('en-US')} tokens` : '');
const indented = (s, pad = '      ') => String(s).replace(/\s+$/, '').split('\n').map((l) => pad + l).join('\n');
// One replayed turn as text: the head, per run its metrics, the calls beside the saved chat's (same provider type; else
// the saved trajectory in one line), the results the model saw (cut at REPLAY_RESULT_CHARS), the answer and the diff.
function replayText(entry, { provider } = {}) {
  const sel = entry.selection ? ` · selection ${entry.selection.split('\n').length} line${entry.selection.includes('\n') ? 's' : ''}` : '';
  const doc = entry.document === 'docs-api' ? `Docs API${entry.tabId ? ` (tab ${entry.tabId})` : ''}` : entry.document ? `export (${entry.document})` : 'no document';
  const mode = !entry.mode || entry.mode === 'edit' ? 'auto' : entry.mode;
  const out = [`Turn ${entry.turn} · ${mode} · ${doc}${sel}: «${entry.prompt.replace(/\s+/g, ' ').slice(0, 160)}»`];
  if (entry.files.length) out.push(`  files (not replayed): ${entry.files.join(', ')}`);
  const s = entry.saved;
  out.push(`  saved: ${[s.provider, s.model].filter(Boolean).join(' ') || 'unknown'} · ${metricsLine(s.metrics, s.metrics.prompt + s.metrics.completion || null)}`);
  if (entry.skipped) { out.push(`  not replayed: ${entry.skipped}`); return out.join('\n'); }
  const same = !!provider && provider === s.providerType;
  entry.runs.forEach((r, k) => {
    out.push(`  run ${k + 1}: ${r.outcome} · ${metricsLine(r.metrics, r.tokens)}` + (r.pass === undefined ? '' : r.pass ? ' · expect: pass' : ` · expect: FAIL (${r.failures.join('; ')})`));
    for (const e of r.errors) out.push(`    error: ${e}`);
    if (same && !r.calls.length && !s.calls.length) out.push('    no calls (the saved chat made none either)');
    else if (same) {
      out.push(`    ${'#'.padEnd(4)}${fit('replay', REPLAY_COLUMN)} | saved chat`);
      for (let i = 0; i < Math.max(r.calls.length, s.calls.length); i++) {
        out.push(`    ${String(i + 1).padEnd(4)}${fit(r.calls[i] ? callLine(r.calls[i]) : '', REPLAY_COLUMN)} | ${s.calls[i] ? fit(callLine(s.calls[i]), REPLAY_COLUMN).trimEnd() : ''}`);
      }
    } else {
      out.push(...r.calls.map((c, i) => `    ${String(i + 1).padEnd(4)}${callLine(c)}`));
      out.push(`    saved chat (${s.providerType || 'another provider'}): ${s.calls.map((c) => c.name + (c.status === 'ok' ? '' : '!')).join(' ') || '(no calls)'}`);
    }
    if (r.calls.length) out.push('    results the model saw:');
    for (const c of r.calls) {
      const more = c.result.length - REPLAY_RESULT_CHARS;
      out.push(`    > ${callLine(c)}`, indented(more > 0 ? `${c.result.slice(0, REPLAY_RESULT_CHARS)}\n… (${more.toLocaleString('en-US')} more characters: --json has all)` : c.result || '(empty)'));
    }
    out.push('    answer:', indented(r.answer || '(none)'));
    out.push(r.diff.length ? `    document diff:\n${indented(r.diff.join('\n'))}` : '    document: unchanged');
  });
  return out.join('\n');
}

module.exports = { loadSets, CHARS_PER_TOKEN, CASES_FILE, REQUIREMENTS, REFUSAL_RE, METRIC_KEYS, unmetRequirements, setAccounts, requirementsMet, caseLines,
  dryModelList, streamUsage, runTokens,
  docsSpec, namedIndents, docLines, caseTurns, cardDecision, askDecision, runOnce, trajectory, trajectoryKey, evaluate, evaluateRun, answerLang, flipRate, runMetrics, caseStats,
  runEval, loadCases, BUNDLE_VERSION, loadBundle, bundleTurnIndices, bundleTurnMessages, savedRounds, savedCards, unreplayable, replayCase, callReports,
  lineDiff, runReplay, replayText };
