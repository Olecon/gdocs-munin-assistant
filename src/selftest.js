'use strict';
// Module selftest.js: the built-in self-test (/test): runSelfTest runs the checks (selfTestChecks) through the
// same functions the turns use, then shows a report card (selfTestCard) with a Markdown copy (selfTestMarkdown).
// /test runs on a new, empty Google Doc only: the harmless checks first, then the "Empty document" gate
// (stEmptyDocument; a document with text or a selection stops it before anything is written), then the write
// cycle (with the Docs API; the reading checks run on the two lines it writes) and the model scenarios (quiet
// turns through toolLoop, verified by re-reading the document; without the Docs API a paste at the cursor, on
// which the reading checks run), with "Your turn" steps in between (the user selects, bolds and removes text by
// hand; Continue / Skip cards, verified by reading the document again). No confirmation card. While it runs, a live
// row in the chat (stLiveStart: the orb and "Self-test: 12 of 38 · Write: table") shows the progress; the status line
// is not used. The report card replaces it; both are notices, not part of the chat history and not stored (Copy takes
// the report's Markdown).
/* global activeConfig, activeProvider, appendToChat, anthropicAdaptive, applyPendingSelection, buildRequest, buildTurnContext,
   chatLockName, closePopup, confirmYourTurn, docIdFromUrl, docLines, docOutline, docsTabFromUrl, docStatusText, el,
   escapeHtml, executeTool, exportAbortError, exportSleep, extraSelfTestRows, fetchDocModel, fetchDocText, fetchModelList, findFlexible, fmtNum,
   FORMAT_READING_TOOL, getDocTab, hasOutline, lineList, normalizeForMatch, OBJECT_CHAR,
   openaiReasoningModel, orbCreate, orbSetState, parseToolArgs, READING_TOOLS, readExport, refreshContext, refreshSelection, refreshSnapModel,
   renderSelection, REPLACE_TOOL, resetDocsApiTurn, runStream, sendToTab, setBusy, setDocSignalTap, setStatus, showText,
   snapshotDocument, state, takeSnapshot, toolLoop, useExportRead, APPLY_MODES */
/* global docsApi, DOCS_GET_FIELDS, fetchDocRevision, LINK_COLOR */
/* exported runSelfTest, ST_SIGNAL */

// ---------------------------------------------------------------------------
// Results and helpers
// ---------------------------------------------------------------------------
// A check returns { status: 'pass' | 'warn' | 'fail' | 'skip', detail (one line), more? (multi-line, shown
// collapsed and in the Markdown details) }. Document text in a result is cut to ST_TEXT_CHARS.
const ST_ICONS = { pass: '✅', warn: '⚠️', fail: '❌', skip: '➖' };
const ST_LABELS = { pass: 'pass', warn: 'warning', fail: 'fail', skip: 'skipped' };
const ST_TEXT_CHARS = 40;
const ST_PROBE_PROMPT = 'Reply with the single word OK.';
const ST_PROBE_TOKENS = 16; // reply limit of the probe completion
const ST_PROBE_THINKING_TOKENS = 1024; // the same for models that think before answering (reasoning counts against the limit)
const ST_STOPPED = 'stopped';

const stResult = (status) => (detail, more) => ({ status, detail, ...(more ? { more: String(more) } : {}) });
const stPass = stResult('pass');
const stWarn = stResult('warn');
const stFail = stResult('fail');
const stSkip = stResult('skip');
const stClip = (t, n = ST_TEXT_CHARS) => {
  const s = String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
};
const stQuote = (t) => `«${stClip(showText(t))}»`;
// read_formatting output in a row's details: its notation header alone is about 300 characters.
const ST_FORMAT_CHARS = 800;
// The line "n: …" of a reading tool's result, or ''.
const stLineOf = (r, n) => String(r.content || '').split('\n').find((l) => l.startsWith(`${n}: `)) || '';
const stPlural = (n, word) => `${fmtNum(n)} ${word}${n === 1 ? '' : 's'}`;
let stCallSeq = 0;

// One tool call on the self-test's turn snapshot (or another snapshot: the model scenarios' re-reads) through
// the turn's path (executeTool → runToolCall → the reading tools / runWriteTool / undo), each call in its own
// "model response".
function stTool(ctx, name, args, snap = ctx.snap) {
  snap.responseWrite = null;
  if (!READING_TOOLS.includes(name) && name !== FORMAT_READING_TOOL) ctx.fresh = false; // a write: the next read must re-read
  const tc = { id: `selftest_${name}_${++stCallSeq}`, type: 'function', function: { name, arguments: JSON.stringify(args) } };
  return executeTool(tc, 'edit', snap, {});
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------
// The Google part of the Environment row: the signed-in account, or the fallback the panel uses.
function stGoogleLine() {
  if (!state.googleConnected) return 'Google: not signed in (export + paste fallback)';
  const email = state.googleAccount && state.googleAccount.email;
  return email ? `Google: signed in as ${email}` : 'Google: signed in';
}

async function stEnvironment(ctx) {
  const prov = activeProvider();
  const cfg = activeConfig();
  let version = '?';
  try { version = chrome.runtime.getManifest().version || '?'; } catch (e) { /* no manifest */ }
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  const chromeVersion = (/Chrome\/([\d.]+)/.exec(ua) || [])[1] || 'unknown';
  const locks = typeof navigator !== 'undefined' && !!navigator.locks && typeof navigator.locks.request === 'function';
  Object.assign(ctx.info, { version, chrome: chromeVersion, provider: prov.label, model: cfg.model || '(none)' });
  const detail = [`v${version}`, `${prov.label} / ${cfg.model || '(no model)'}`, cfg.apiKey ? 'API key set' : 'no API key',
    stGoogleLine(), `Mode: ${APPLY_MODES[state.applyMode] || state.applyMode}`, locks ? 'Web Locks available' : 'no Web Locks', `Chrome ${chromeVersion}`].join(' · ');
  if (!cfg.apiKey) return stWarn(detail, `No ${prov.label} API key is set: the provider checks are skipped.`);
  if (!locks) return stWarn(detail, 'navigator.locks is unavailable: tabs of one document are kept apart only within this panel.');
  return stPass(detail);
}

async function stContentScript() {
  const t0 = Date.now();
  const r = await sendToTab({ type: 'PING' });
  const ms = Date.now() - t0;
  if (!r || !r.ok) return stFail('the document tab did not answer PING');
  const detail = `PING ${ms} ms · document ${r.docId || '?'} · ${stQuote(r.title || '')}`;
  if (r.docId && state.docId && r.docId !== state.docId) return stWarn(`${detail} · the panel shows ${state.docId}`);
  return stPass(detail);
}

// What the content script's change signal found on the page (GET_SIGNAL_STATE): the editor container its observer
// watches (a collaborator's edits), the hidden iframe whose key and input events it listens to, and its counters since
// the page loaded.
async function stChangeSignal() {
  let r;
  try { r = await sendToTab({ type: 'GET_SIGNAL_STATE' }); } catch (e) { return stWarn(`could not ask the content script: ${e.message}`); }
  if (!r || !r.ok || r.editor === undefined) return stWarn('the content script does not report its change signal: reload the Docs tab');
  const s = r.stats || {};
  const n = (k) => fmtNum(Number(s[k]) || 0);
  const parts = [
    r.editor && r.observing ? `editor ${r.editorSelector} observed` : `editor ${r.editorSelector} not found`,
    !r.iframe ? 'hidden iframe not found' : r.listening ? 'hidden iframe listened to' : 'hidden iframe found, its document not reachable',
    `so far: keys ${n('keydownFrame')} in the iframe and ${n('keydownPage')} on the page, beforeinput ${n('beforeinput')}, page changes ${n('mutations')}`,
  ];
  const detail = parts.join(' · ');
  const more = `Sent: DOC_TYPED ×${n('typedSent')}, DOC_CHANGED ×${n('changedPage')} from the page and ×${n('changedInput')} from keys and input; ` +
    `the iframe was replaced ${stPlural(Number(s.iframeSwaps) || 0, 'time')}.`;
  if (!r.editor || !r.observing) return stWarn(`${detail}: edits of other people show late`, more);
  if (!r.iframe || !r.listening) return stWarn(`${detail}: the numbers move only when the page itself gets the keys`, more);
  return stPass(detail, more);
}

async function stSelection() {
  let r;
  try { r = await sendToTab({ type: 'GET_SELECTION' }); } catch (e) { return stWarn(`could not read the selection: ${e.message}`); }
  const text = (r && r.ok && r.text) || '';
  return stPass(text ? `${stPlural(text.length, 'character')} (${r.cached ? 'cached' : 'live'})` : 'nothing selected');
}

// The one export read of the run (readExport: the panel's own export, the content script's as the fallback);
// The "Empty document" gate reuses its text when the turn would read the export too. An empty export is not a failure.
// runSelfTest appends how many export requests the whole run made.
async function stExport(ctx) {
  let r;
  try { r = await readExport(ctx.tab, () => {}, { signal: ctx.signal }); } catch (e) { ctx.expError = e.message; throw e; }
  ctx.exp = r;
  ctx.fresh = true;
  const route = r.via === 'tab' ? 'read by the content script' : 'read by the panel';
  const why = r.via === 'tab' ? `The panel's own export failed (${r.panelError || 'unknown error'}); the content script's export worked, so turns still read the document.` : '';
  const detail = r.text.trim()
    ? `${stPlural(r.text.length, 'character')} · ${r.format} · ${stPlural(r.text.split('\n').length, 'line')} · ${route}`
    : `empty document: the export returned no text (${r.format}) · ${route}`;
  return r.via === 'tab' ? stWarn(`${detail} (the panel's export failed)`, why) : stPass(detail);
}

// The self-test's export scheduler (state.exportPace while it runs): at least ST_EXPORT_PACE.gapMs between the
// last export request and the next read (Stop ends the wait), and the count of export requests.
const ST_EXPORT_PACE = { gapMs: 2000 }; // tests shorten it
function stExportPacer(signal) {
  const p = {
    reads: 0, requests: 0, last: 0,
    async beforeRead() {
      const wait = p.last ? p.last + ST_EXPORT_PACE.gapMs - Date.now() : 0;
      if (wait > 0) await exportSleep(wait, signal);
      p.reads++;
    },
    onRequest(n) { p.requests += n; p.last = Date.now(); },
  };
  return p;
}

// The first text of a model the export must contain too: the first heading, else the first non-empty line
// (the part before an embedded object or a soft break).
function stProbeText(model) {
  const heading = model.lines.find((l) => l.heading && l.text.trim());
  const line = heading || model.lines.find((l) => l.text.trim());
  if (!line) return null;
  const part = line.text.split('\u000b').join(OBJECT_CHAR).split(OBJECT_CHAR).map((s) => s.trim()).find((s) => s.length >= 3);
  return part ? { text: part, what: heading ? 'the first heading' : 'the first line' } : null;
}
const stLoose = (t) => normalizeForMatch(String(t).replace(/\\/g, '')).text.toLowerCase().replace(/\s+/g, ' ').trim();

async function stDocsApi(ctx) {
  if (!state.googleConnected) return stSkip('Google account not connected');
  const id = docIdFromUrl(ctx.tab.url);
  resetDocsApiTurn();
  const m = await fetchDocModel(id, docsTabFromUrl(ctx.tab.url), false);
  ctx.apiModel = m;
  const headings = m.lines.filter((l) => l.heading && l.text.trim()).length;
  const inexact = m.lines.filter((l) => !l.exact).map((l) => l.line);
  const suggested = m.lines.filter((l) => l.suggested).length;
  const objects = m.text.split(OBJECT_CHAR).length - 1;
  const soft = m.text.split('\u000b').length - 1;
  const detail = `revision ${stClip(m.revisionId, 12)} · tab ${m.tabId || '(none)'} of ${m.tabCount || 1} · ` +
    `${stPlural(m.lines.length, 'line')} · ${stPlural(headings, 'heading')} · ${suggested} with suggestions · ` +
    `${stPlural(objects, 'embedded object')} · ${stPlural(soft, 'soft break')}`;
  const issues = [];
  if (inexact.length) issues.push(`Lines whose positions cannot be mapped exactly (edits refuse them): ${lineList(inexact)}.`);
  const probe = ctx.exp ? stProbeText(m) : null;
  if (probe && !stLoose(ctx.exp.text).includes(stLoose(probe.text))) {
    issues.push(`The API text and the export disagree: ${probe.what} ${stQuote(probe.text)} does not occur in the export.`);
  }
  return issues.length ? stWarn(detail, issues.join('\n')) : stPass(detail);
}

// The turn's read: a snapshot taken as runTurn takes it (the "Empty document" gate decides on it). Without
// Google the turn would read the export, so the text "Export read" just read is used (its failure too) instead
// of a second export request.
async function stTurnSnapshot(ctx) {
  const snap = takeSnapshot();
  snap.signal = ctx.signal;
  resetDocsApiTurn();
  if (!state.googleConnected && (ctx.exp || ctx.expError)) {
    await refreshSelection();
    if (ctx.exp) useExportRead(ctx.exp);
    else { state.docText = null; state.docModel = null; state.docError = ctx.expError; }
  } else {
    await Promise.all([refreshSelection(), fetchDocText()]);
  }
  ctx.fresh = state.docText != null;
  snapshotDocument(snap);
  // open_document would store opened documents on this chat context: a scratch one, never saved.
  snap.chatCtx = { docId: state.docId, chatId: state.chatId, messages: [] };
  snap.mainUrl = ctx.tab.url;
  ctx.snap = snap;
  return snap;
}

// ---- The reading checks ------------------------------------------------------------------------
// They run once, on the test text the self-test wrote (ctx.content: { snap, line (the test paragraph's line),
// text (that line), api }): with the Docs API on the write cycle's two lines, without it on the paragraph the
// model pasted at the cursor. ctx.contentWhy: why there is no test text.
const stContentCheck = (fn) => async (ctx) => {
  const c = ctx.content;
  if (!c) return stSkip(ctx.contentWhy || 'not run: the self-test wrote no test text');
  return fn(ctx, c);
};
const stContentLines = (c) => (c.api ? c.snap.model.lines.map((l) => l.text) : docLines(c.snap));

const stOutline = stContentCheck(async (ctx, c) => {
  const r = await stTool(ctx, 'get_outline', {}, c.snap);
  if (!r._ok) return stFail(stClip(r.content, 160));
  if (!hasOutline(c.snap)) return stPass('plain-text export: no outline (expected)');
  const items = docOutline(c.snap);
  if (!items.length) {
    return r.content.startsWith('The document has no headings') ? stPass('no headings (the "no headings" note)') : stFail('unexpected result', r.content.slice(0, 300));
  }
  if (!r.content.startsWith(`${items.length} heading`)) return stFail(`expected ${stPlural(items.length, 'heading')}`, r.content.slice(0, 300));
  return stPass(`${stPlural(items.length, 'heading')}; the first on line ${items[0].line}: ${stQuote(items[0].title)}`);
});

const stReadLines = stContentCheck(async (ctx, c) => {
  const lines = stContentLines(c);
  const r = await stTool(ctx, 'read_lines', { start: 1, end: lines.length }, c.snap);
  if (!r._ok) return stFail(stClip(r.content, 160));
  const want = lines[c.line - 1];
  const got = r.content.split('\n').find((l) => l.startsWith(`${c.line}: `));
  if (got == null || !got.startsWith(`${c.line}: ${showText(want)}`)) {
    return stFail(`line ${c.line} of read_lines differs from line ${c.line} of the document`, `read_lines: ${stClip(got, 80)}\ndocument: ${stClip(want, 80)}`);
  }
  const m = /^Lines 1-(\d+) of (\d+)/m.exec(r.content);
  return stPass(`lines 1–${m ? m[1] : '?'} of ${m ? m[2] : '?'}; line ${c.line} ${stQuote(want)}`);
});

const stFind = stContentCheck((ctx, c) => stFindOn(ctx, c.snap, c.line));
// find_in_document of the first word of 4+ letters of line lineNo (1-based): a hit on that line.
async function stFindOn(ctx, snap, lineNo) {
  const m = /\p{L}{4,}/u.exec(docLines(snap)[lineNo - 1] || '');
  if (!m) return stSkip(`no word of 4 or more letters in line ${lineNo}`);
  const word = m[0];
  const r = await stTool(ctx, 'find_in_document', { query: word }, snap);
  const hits = r.content.split('\n').slice(1);
  if (!r._ok || !hits.some((h) => h.startsWith(`${lineNo}: `))) return stFail(`"${stClip(word, 20)}" was not found on line ${lineNo}`, r.content.slice(0, 300));
  return stPass(`"${stClip(word, 20)}" found on line ${lineNo}`);
}

// get_selection with a simulated selection: the test line (Docs cannot be selected programmatically).
const stGetSelection = stContentCheck(async (ctx, c) => {
  const sel = stTrim(c.text);
  const saved = c.snap.selection;
  c.snap.selection = sel;
  let r;
  try { r = await stTool(ctx, 'get_selection', {}, c.snap); } finally { c.snap.selection = saved; }
  if (!r._ok || !r.content.includes(sel)) return stFail('the result does not contain the selection', stClip(r.content, 160));
  const where = (/^Selection \(([^,]+),/.exec(r.content) || [])[1] || '?';
  const detail = `selection simulated on line ${c.line} (${stPlural(sel.length, 'character')}): ${where}`;
  if (where !== `lines ${c.line}-${c.line}`) return stFail(`${detail}, expected lines ${c.line}-${c.line}`, stClip(r.content, 160));
  return stPass(detail);
});

const stReadFormatting = stContentCheck(async (ctx, c) => {
  if (!c.api) return stNeedsApi();
  const from = Math.max(1, c.line - 1);
  const r = await stTool(ctx, 'read_formatting', { start: from, end: c.line }, c.snap);
  if (!r._ok) return stFail(stClip(r.content, 160));
  const body = r.content.split('\n').filter((l) => /^\d+: /.test(l));
  if (!body.some((l) => l.startsWith(`${c.line}: ${ST_SECTION.para}`))) return stFail(`line ${c.line} is not the plain fox paragraph`, stClip(r.content, ST_FORMAT_CHARS));
  return stPass(`lines ${from}–${c.line}: ${stPlural(body.length, 'line')}, plain text`);
});

// A unique piece of a line with an inner space (no embedded objects or soft breaks), at most ~120 characters;
// only: look at that line (1-based) only.
function stMatchCandidate(hay, only = 0) {
  let off = 0;
  const lines = hay.split('\n');
  for (let i = 0; i < lines.length; off += lines[i].length + 1, i++) {
    if (only && i + 1 !== only) continue;
    let t = lines[i].trim();
    if (t.length > 120) t = t.slice(0, Math.max(t.lastIndexOf(' ', 120), 8)).trim();
    if (t.length < 8 || !/\S \S/.test(t) || t.includes(OBJECT_CHAR) || t.includes('\u000b')) continue;
    const at = lines[i].indexOf(t);
    if (findFlexible(hay, t, { normalize: false }).length !== 1) continue;
    return { line: i + 1, text: t, at: off + at };
  }
  return null;
}
const ST_TYPOGRAPHIC = { "'": '\u2019', '"': '\u201C', '-': '\u2010' }; // right single quote, left double quote, hyphen

const stMatching = stContentCheck((ctx, c) => stMatchingOn(c.api ? c.snap.model.text : c.snap.docText, c.line));
function stMatchingOn(hay, only = 0) {
  const c = stMatchCandidate(hay, only);
  if (!c) return stSkip(only ? `line ${only} has no unique text with an inner space` : 'no unique line with an inner space');
  const exact = findFlexible(hay, c.text);
  if (exact.length !== 1 || exact[0].at !== c.at || exact[0].normalized) {
    return stFail(`the exact search of line ${c.line} did not find exactly that place (${stPlural(exact.length, 'hit')})`);
  }
  const sp = c.text.search(/\S \S/) + 1;
  let variant = c.text.slice(0, sp) + '\u00A0' + c.text.slice(sp + 1); // a non-breaking space
  const q = /['"-]/.exec(variant);
  if (q) variant = variant.slice(0, q.index) + ST_TYPOGRAPHIC[q[0]] + variant.slice(q.index + 1);
  const what = 'NBSP' + (q ? ` + ${ST_TYPOGRAPHIC[q[0]]}` : '');
  const hits = findFlexible(hay, variant);
  if (hits.length !== 1 || hits[0].at !== c.at || hits[0].text !== c.text || !hits[0].normalized) {
    return stFail(`with ${what} the normalized search did not find line ${c.line} exactly (${stPlural(hits.length, 'hit')})`, `line: ${stQuote(c.text)}`);
  }
  return stPass(`line ${c.line} ${stQuote(c.text)}: exact match, and with ${what} a normalized match at the same place`);
}

async function stModelList() {
  const prov = activeProvider();
  const cfg = activeConfig();
  if (!cfg.apiKey) return stSkip(`no ${prov.label} API key`);
  const ids = await fetchModelList(prov.id, cfg);
  const detail = `GET /models · ${stPlural(ids.length, 'model')}`;
  if (cfg.model && !ids.includes(cfg.model)) return stWarn(`${detail} · "${cfg.model}" is not in the list`, 'Open the settings and click Check models.');
  return stPass(detail);
}

async function stCompletion(ctx) {
  const prov = activeProvider();
  if (!activeConfig().apiKey) return stSkip(`no ${prov.label} API key`);
  const snap = takeSnapshot();
  snapshotDocument(snap);
  snap.signal = ctx.signal;
  snap.chatCtx = { docId: state.docId, chatId: state.chatId, messages: [] };
  const thinks = prov.id === 'munin' || (prov.id === 'openai' && openaiReasoningModel(snap.cfg.model)) ||
    (prov.id === 'anthropic' && anthropicAdaptive(snap.cfg.model));
  const req = buildRequest('manual', snap, {
    history: [{ role: 'user', content: ST_PROBE_PROMPT }], noTools: true, maxTokens: thinks ? ST_PROBE_THINKING_TOKENS : ST_PROBE_TOKENS,
  });
  const r = await runStream(req, ctx.signal, snap, {});
  const content = String(r.content || '').trim();
  const u = r.usage;
  const usage = u && (u.prompt_tokens != null || u.completion_tokens != null)
    ? `${fmtNum(u.prompt_tokens || 0)} in / ${fmtNum(u.completion_tokens || 0)} out tokens` : 'no usage reported';
  const detail = `${snap.cfg.model} · reply «${stClip(content, 20) || '(empty)'}» · ${usage}`;
  if (!/\bOK\b/i.test(content)) return stWarn(detail, `The reply does not contain "OK" (finish reason: ${r.finishReason || 'unknown'}).`);
  return stPass(detail);
}

// ---- The "Empty document" gate ----------------------------------------------------------------------
// /test writes only into a new, empty Google Doc: it takes the turn snapshot (as a turn reads the document)
// and stops when the text read (the Docs API model, else the export) has any non-whitespace character or
// text is selected (a paste would replace it). Stopped: every write, reading and model row is skipped with
// the reason. Passed: it decides the mode (ctx.mode: 'api' with the Docs API model, else 'export'), sets up
// the write cycle and marks the model scenarios ready.
const ST_NOT_EMPTY_HINT = 'open a new, empty Google Doc and run /test there';
async function stEmptyDocument(ctx) {
  const ph = ctx.phase;
  const mp = ctx.mp;
  const stop = (detail, more) => {
    const why = `not run: ${detail}`;
    ph.skipWhy = why;
    mp.skipWhy = why;
    ctx.contentWhy = why;
    return stFail(detail, more);
  };
  const snap = await stTurnSnapshot(ctx);
  if (snap.docText == null) return stop(`the document text is unavailable: ${snap.docError || 'the read failed'}`);
  const api = !!(snap.model && state.googleConnected);
  const text = api ? snap.model.text : snap.docText;
  const size = `${stPlural(text.length, 'character')}, ${stPlural(stLines(text).length, 'line')}`;
  if (text.trim()) return stop(`the document is not empty (${size}): ${ST_NOT_EMPTY_HINT}`);
  let sel = '';
  try { const r = await sendToTab({ type: 'GET_SELECTION' }); sel = (r && r.ok && r.text) || ''; } catch (e) { /* treated as none */ }
  if (sel.trim()) {
    return stop(`text is selected in the document (${stPlural(sel.length, 'character')}): click once in the document so that ` +
      'nothing is selected, then run /test again (a paste would replace the selection)');
  }
  ctx.mode = api ? 'api' : 'export';
  const reason = (why) => why.replace(/^not run: /, '');
  const write = stWritePossible(ctx);
  const model = stModelPossible(ctx);
  if (!api) ctx.contentWhy = model ? 'not run: the test paragraph was not inserted' : mp.skipWhy;
  const parts = [write ? stWriteSetup(ctx) : `no write cycle (${reason(ph.skipWhy)})`];
  if (model) mp.ready = true;
  parts.push(model ? `model scenarios (${api ? 'Docs API' : 'export only: a paste at the cursor and a question'})` : `no model scenarios (${reason(mp.skipWhy)})`);
  const detail = `empty: ${size} (${api ? 'Docs API' : `export, ${snap.docFormat}`}) · nothing selected · ${parts.join(' · ')}`;
  if (state.googleConnected && !api) {
    return stWarn(detail, 'Google is connected, but the turn read fell back to the export: the Docs API failed, so the writing tools are unavailable.');
  }
  return stPass(detail);
}

// ---- The write cycle -----------------------------------------------------------------------------------
// The edits run on the turn snapshot in Auto mode with the real writing tools. Their journal (the tool
// results with _edit, which undo_last_edit reads from state.messages) is a scratch history: state.messages
// points to it during the write phase and is restored at the end (runSelfTest), so nothing reaches the chat.
// It writes the two test lines (ST_SECTION), runs the reading checks on them (ctx.content), edits, formats
// and deletes them, then inserts a line again and undoes it: the document is empty again.
// What the write cycle needs: a connected Google account and a Docs API read (else ph.skipWhy).
function stWritePossible(ctx) {
  const ph = ctx.phase;
  if (!state.googleConnected) ph.skipWhy = 'not run: needs a connected Google account';
  else if (!ctx.snap || !ctx.snap.model) ph.skipWhy = 'not run: no Docs API model';
  return !ph.skipWhy;
}
// After the gate: the scratch journal and the original (empty) text and revision.
function stWriteSetup(ctx) {
  const ph = ctx.phase;
  ph.allowed = true;
  ph.saved = state.messages;
  state.messages = ph.journal;
  const m = ctx.snap.model;
  ph.T0 = m.text;
  ph.R0 = m.revisionId;
  ph.last = m.lines.length;
  ctx.contentWhy = 'not run: the write cycle did not write the test lines';
  return `write cycle (revision ${stClip(ph.R0, 12)}, ${stPlural(ph.last, 'line')})`;
}

// Runs one write step: skipped when the phase did not start or an earlier step failed; a failure ends the
// phase and names what is left in the document.
function stWriteStep(fn) {
  return async (ctx) => {
    const ph = ctx.phase;
    if (!ph.allowed) return stSkip(ph.skipWhy || 'not run');
    if (ph.failed) return stSkip('not run: an earlier write step failed');
    let res;
    try { res = await fn(ctx, ph); } catch (e) {
      if (ctx.signal.aborted || e.name === 'AbortError') throw e;
      res = stFail(e.message || String(e));
    }
    if (res.status === 'fail') {
      ph.failed = true;
      const left = await stLeftover(ctx);
      res = { ...res, detail: `${res.detail} · ${left}`, more: [res.more, left].filter(Boolean).join('\n') };
    }
    return res;
  };
}
// Calls a writing tool; a refused or failed call throws with the tool's message.
async function stWrite(ctx, name, args) { // a writing tool through stTool (which marks the last read stale)
  const r = await stTool(ctx, name, args);
  ctx.phase.journal.push(r);
  if (!r._ok) throw new Error(`${name} failed: ${stClip(r._message || r.content, 160)}`);
  return r;
}
const stDocLine = (ctx, n) => ctx.snap.model.lines[n - 1];
const ST_UNDO_LINE = 'Self-test undo line';

// What of the self-test is left in the document (read again): every non-empty line, since it started empty.
async function stLeftover(ctx) {
  let lines = null;
  try {
    const m = await fetchDocModel(ctx.snap.model.docId, ctx.snap.model.tabId);
    lines = m.lines.filter((l) => l.text.trim());
  } catch (e) { /* unknown */ }
  if (lines && !lines.length) return 'Nothing of the self-test is left in the document.';
  if (lines) return `Left in the document: ${lines.map((l) => `line ${l.line} «${showText(l.text)}»`).join(', ')}. Delete it by hand.`;
  return `The document could not be read again; delete the self-test lines («${ST_SECTION.heading}», «${ST_SECTION.para}») by hand.`;
}

const stInsert = stWriteStep(async (ctx, ph) => {
  await stWrite(ctx, 'insert_after_line', { line: ph.last, text: `${ST_SECTION.heading}\n${ST_SECTION.para}` });
  const h = stDocLine(ctx, ph.last + 1);
  const p = stDocLine(ctx, ph.last + 2);
  if (!h || !p || h.text !== ST_SECTION.heading || p.text !== ST_SECTION.para) {
    return stFail(`after the insert lines ${ph.last + 1}–${ph.last + 2} read ${stQuote(h ? h.text : '')} / ${stQuote(p ? p.text : '')}`);
  }
  ph.head = h.line;
  ph.line = p.line;
  ctx.content = { snap: ctx.snap, line: p.line, text: p.text, api: true };
  Object.assign(ctx.it, { ready: true, api: true, line: p.line, text: p.text });
  return stPass(`lines ${h.line}–${p.line} read «${ST_SECTION.heading}» / ${stQuote(ST_SECTION.para)}`);
});

const ST_REPLACED = 'The slow green turtle jumps over the lazy dog.';
const stReplace = stWriteStep(async (ctx, ph) => {
  const note = await stHandRewriteApi(ctx, ph);
  await stWrite(ctx, 'replace_text', { old_text: 'quick brown fox', new_text: 'slow green turtle' });
  const l = stDocLine(ctx, ph.line);
  if (!l || l.text !== ST_REPLACED) return stFail(`after replace_text line ${ph.line} reads ${stQuote(l ? l.text : '')}${note}`);
  return stPass(`line ${ph.line} reads ${stQuote(ST_REPLACED)} after the re-read${note}`);
});

// With the Docs API the Your-turn steps run on the write cycle's paragraph (it.shown: a card was shown or the
// model replaced the selection), which the user or the model may have changed (red cat, a bold word). Before
// the write cycle goes on, the panel re-reads the document and, unless read_formatting shows the original plain
// paragraph, writes it again: line ph.line deleted and inserted anew after the heading (plain text). Returns
// the note for the row ('' when nothing was needed); throws when the two test lines are no longer there.
async function stHandRewriteApi(ctx, ph) {
  const it = ctx.it;
  if (!it.shown) return '';
  it.shown = false;
  const m = await refreshSnapModel(ctx.snap);
  const h = m.lines[ph.head - 1];
  if (m.lines.length !== ph.line || !h || h.text !== ST_SECTION.heading) {
    throw new Error(`after the Your-turn steps lines ${ph.head}–${ph.line} are not the test lines (${stPlural(m.lines.length, 'line')}, line ${ph.head} ${stQuote(h ? h.text : '')})`);
  }
  const f = await stTool(ctx, FORMAT_READING_TOOL, { start: ph.line, end: ph.line });
  if (f._ok && f.content.split('\n').includes(`${ph.line}: ${ST_SECTION.para}`)) return '';
  await stWrite(ctx, 'delete_lines', { start: ph.line, end: ph.line });
  await stWrite(ctx, 'insert_after_line', { line: ph.head, text: ST_SECTION.para });
  const l = stDocLine(ctx, ph.line);
  if (!l || l.text !== ST_SECTION.para) throw new Error(`the panel could not write the test paragraph again: line ${ph.line} reads ${stQuote(l ? l.text : '')}`);
  return ` · after the Your-turn steps the panel wrote line ${ph.line} again as ${stQuote(ST_SECTION.para)} (plain)`;
}

const stFormat = stWriteStep(async (ctx, ph) => {
  await stWrite(ctx, 'format_text', { old_text: 'lazy dog', bold: true, italic: null, underline: null });
  const r = await stTool(ctx, 'read_formatting', { start: ph.line, end: ph.line });
  if (!r.content.includes(`${ph.line}: The slow green turtle jumps over the **lazy dog**.`)) {
    return stFail('read_formatting does not show «lazy dog» as bold', stClip(r.content, ST_FORMAT_CHARS));
  }
  return stPass(`read_formatting shows line ${ph.line} with **lazy dog**`);
});

// The format_lines arguments with every property null except over.
const ST_LINES_NULLS = { style: null, align: null, list: null, indent_start: null, indent_first_line: null, space_above: null, space_below: null, line_spacing: null };
const stLinesArgs = (start, end, over) => ({ start, end, ...ST_LINES_NULLS, ...over });
const ST_TEXT_NULLS = { bold: null, italic: null, underline: null, font: null, size: null, color: null, highlight: null, link: null };
const ST_LINK = 'https://example.com/';

// format_text with the text styles (font, size, colors) and a link on the fox line, then undone twice: back to
// **lazy dog** only. Whether Docs styled the link itself (underline, link blue) is reported as a fact.
const stTextStyles = stWriteStep(async (ctx, ph) => {
  const n = ph.line;
  const read = async () => stLineOf(await stTool(ctx, 'read_formatting', { start: n, end: n }), n);
  const base = `${n}: The slow green turtle jumps over the **lazy dog**.`;
  await stWrite(ctx, 'format_text', { old_text: 'lazy dog', ...ST_TEXT_NULLS, italic: true, font: 'Courier New', size: 14, color: '#FF0000', highlight: '#FFFF00' });
  const styled = `${n}: The slow green turtle jumps over the {***lazy dog***}(font=Courier New size=14 color=#FF0000 bg=#FFFF00).`;
  let got = await read();
  if (got !== styled) return stFail('read_formatting does not show the text styles on «lazy dog»', `read_formatting: ${stClip(got, 200)}\nexpected: ${styled}`);
  await stWrite(ctx, 'format_text', { old_text: 'turtle', ...ST_TEXT_NULLS, link: ST_LINK });
  got = await read();
  if (!/\[(__)?turtle(__)?\]\(https:\/\/example\.com\/\)/.test(got)) return stFail('read_formatting does not show «turtle» as a link', `read_formatting: ${stClip(got, 200)}`);
  const run = (stDocLine(ctx, n).runs || []).find((r) => r.link === ST_LINK) || {};
  const auto = run.underline || run.color === LINK_COLOR ? `Docs styled the link itself (${[run.underline ? 'underline' : '', run.color || ''].filter(Boolean).join(', ')})` : 'Docs did not style the link';
  await stWrite(ctx, 'undo_last_edit', {});
  await stWrite(ctx, 'undo_last_edit', {});
  got = await read();
  if (got !== base) return stFail('after two undo_last_edit the line is not back to **lazy dog** only', `read_formatting: ${stClip(got, 200)}`);
  return stPass(`line ${n}: {***lazy dog***}(font=Courier New size=14 color=#FF0000 bg=#FFFF00), [turtle](${ST_LINK}); undone twice · ${auto}`);
});

// format_lines on the heading: style h2, then alignment and spacing; undone twice (style and tag as before).
const stFormatLines = stWriteStep(async (ctx, ph) => {
  const h = ph.head;
  const style0 = stDocLine(ctx, h).style;
  const read = async () => stLineOf(await stTool(ctx, 'read_formatting', { start: h, end: h }), h);
  const steps = [
    [{ style: 'h2' }, `${h}: [h2] ${ST_SECTION.heading}`, 'HEADING_2'],
    [{ align: 'center', space_above: 12, space_below: 6, line_spacing: 1.5 }, `${h}: [h2 center space 12/6 line 1.5] ${ST_SECTION.heading}`, 'HEADING_2'],
  ];
  for (const [over, want, style] of steps) {
    await stWrite(ctx, 'format_lines', stLinesArgs(h, h, over));
    const got = await read();
    const st = stDocLine(ctx, h).style;
    if (got !== want || st !== style) return stFail(`after format_lines ${JSON.stringify(over)} line ${h} reads ${stClip(got, 120)} (style ${st || 'none'})`, `expected: ${want}`);
  }
  await stWrite(ctx, 'undo_last_edit', {});
  await stWrite(ctx, 'undo_last_edit', {});
  const got = await read();
  const st = stDocLine(ctx, h).style;
  if (got !== `${h}: ${ST_SECTION.heading}` || st !== style0) return stFail(`after two undo_last_edit line ${h} reads ${stClip(got, 120)} (style ${st || 'none'}, before ${style0 || 'none'})`);
  return stPass(`line ${h}: [h2], then [h2 center space 12/6 line 1.5]; undone twice (style ${style0 || 'none'} again)`);
});

// Lists on two inserted items: numbered, checklist, none, each undone in turn; the items are deleted again so the
// later rows see the two test lines. A missing tag prints the raw bullet and nesting level (stListRaw).
const ST_ITEMS = ['Item one', 'Item two'];
const stLists = stWriteStep(async (ctx, ph) => {
  await stWrite(ctx, 'insert_after_line', { line: ph.line, text: ST_ITEMS.join('\n') });
  const a = ph.line + 1;
  const b = ph.line + 2;
  const check = async (step, tag) => {
    const r = await stTool(ctx, 'read_formatting', { start: a, end: b });
    const got = [a, b].map((k) => stLineOf(r, k));
    const want = ST_ITEMS.map((t, i) => `${a + i}: ${tag ? `[${tag}] ` : ''}${t}`);
    if (got.join('\n') === want.join('\n')) return null;
    return stFail(`${step}: lines ${a}–${b} read ${got.map((t) => stClip(t, 60)).join(' / ')}, expected ${tag ? `[${tag}]` : 'no tag'}`, await stListRaw(ctx, [a, b]));
  };
  const steps = [['list number', { list: 'number' }, 'number'], ['list checklist', { list: 'checklist' }, 'checklist'], ['list none', { list: 'none' }, ''],
    ['undo 1', null, 'checklist'], ['undo 2', null, 'number'], ['undo 3', null, '']];
  for (const [step, over, tag] of steps) {
    await (over ? stWrite(ctx, 'format_lines', stLinesArgs(a, b, over)) : stWrite(ctx, 'undo_last_edit', {}));
    const bad = await check(step, tag);
    if (bad) return bad;
  }
  await stWrite(ctx, 'delete_lines', { start: a, end: b });
  if (ctx.snap.model.lines.length !== ph.line) return stFail(`after deleting the items the document has ${stPlural(ctx.snap.model.lines.length, 'line')}, expected ${ph.line}`);
  return stPass(`lines ${a}–${b}: [number], [checklist], no tag; undone three times; the items deleted again`);
});
// The raw list facts of lines (a fresh documents.get): each line's bullet and its nesting level's glyphs.
async function stListRaw(ctx, nums) {
  try {
    const m = ctx.snap.model;
    const doc = await docsApi(`${encodeURIComponent(m.docId)}?includeTabsContent=true&fields=${DOCS_GET_FIELDS}`);
    const flat = (tabs) => (tabs || []).flatMap((t) => [t, ...flat(t.childTabs)]);
    const tab = flat(doc.tabs).find((t) => t.tabProperties && t.tabProperties.tabId === m.tabId) || flat(doc.tabs)[0] || {};
    const dt = tab.documentTab || {};
    const content = (dt.body && dt.body.content) || [];
    return 'Raw: ' + nums.map((k) => {
      const l = m.lines[k - 1];
      const se = l && content.find((c) => c.paragraph && c.startIndex === l.start);
      const bullet = se && se.paragraph.bullet;
      if (!bullet) return `line ${k} has no bullet`;
      const levels = dt.lists && dt.lists[bullet.listId] && dt.lists[bullet.listId].listProperties && dt.lists[bullet.listId].listProperties.nestingLevels;
      const lv = (levels && levels[bullet.nestingLevel || 0]) || {};
      const glyph = { glyphType: lv.glyphType, glyphSymbol: lv.glyphSymbol, glyphFormat: lv.glyphFormat };
      return `line ${k} bullet ${JSON.stringify(bullet)} level ${JSON.stringify(glyph)}`;
    }).join('; ');
  } catch (e) {
    return `Raw: the document could not be read (${e.message})`;
  }
}

const stDelete = stWriteStep(async (ctx, ph) => {
  await stWrite(ctx, 'delete_lines', { start: ph.head, end: ph.line });
  if (ctx.snap.model.text !== ph.T0) return stFail(`after deleting lines ${ph.head}–${ph.line} the document is not empty`);
  return stPass(`lines ${ph.head}–${ph.line} deleted; the document is empty again`);
});

const stUndo = stWriteStep(async (ctx, ph) => {
  await stWrite(ctx, 'insert_after_line', { line: ph.last, text: ST_UNDO_LINE });
  await stWrite(ctx, 'undo_last_edit', {});
  const m = ctx.snap.model;
  if (m.text !== ph.T0) return stFail('after undo_last_edit the document is not empty');
  if (m.revisionId === ph.R0) return stFail('the revision did not change');
  ph.done = true;
  return stPass(`inserted «${ST_UNDO_LINE}», undo_last_edit; the document is empty again · revision ${stClip(ph.R0, 12)} → ${stClip(m.revisionId, 12)}`);
});

async function stMultiTab() {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : null;
  if (!locks || typeof locks.query !== 'function') return stSkip('navigator.locks.query is unavailable');
  const q = await locks.query();
  const name = chatLockName(state.docId, state.chatId);
  const prefix = chatLockName(state.docId, '');
  const held = (q.held || []).filter((l) => l.name === name).length;
  const waiting = (q.pending || []).filter((l) => l.name === name).length;
  const others = (q.held || []).filter((l) => l.name.startsWith(prefix) && l.name !== name).length;
  const rest = others ? `; ${stPlural(others, 'other chat')} of this document busy in other tabs` : '';
  if (held) return stPass(`another tab holds this chat (answering or undoing)${waiting ? `, ${waiting} waiting` : ''}${rest}`);
  return stPass(`no other tab holds this chat${rest}`);
}

// ---- The model scenarios ------------------------------------------------------------------------
// The active provider gets literal instructions and does the work itself: each scenario is a turn through
// toolLoop (buildRequest with the real system prompt and tools, runStream, executeTool with the edit gate),
// in Auto mode for edits and Manual for the question, on a scratch history (state.messages points to it
// while the scenario runs; runSelfTest restores the chat's history). The panel then re-reads the document
// (Docs API model or export) and checks it; the model's own words are never trusted. Without the Docs API
// only the paste at the cursor (replace_selection) and the question can run.
// apiTries / apiWaitMs: Docs saves a manual edit to the server a second or two after it is made, so a
// Docs API read right after "Continue" may not show it yet.
const ST_MODEL = { timeoutMs: 90000, exportTries: 2, exportWaitMs: 3000, apiTries: 3, apiWaitMs: 1500 }; // tests shorten these
const ST_NEEDS_API = 'needs a Google account (Docs API)';
const stNeedsApi = () => stSkip(state.googleConnected ? 'needs the Docs API (the read through it failed)' : ST_NEEDS_API);
const ST_ANSWER_CHARS = 200;
const ST_SECTION = { heading: 'Self-test section', para: 'The quick brown fox jumps over the lazy dog.', extra: 'A turtle is a turtle.' };
const ST_PASTE_TEXT = 'Self-test paragraph: the quick brown fox jumps over the lazy dog.';
// The instructions, sent as the user's message of each scenario (English, literal).
const ST_PROMPTS = {
  write: "At the end of the document add a heading line 'Self-test section' and, below it, one paragraph: " +
    "'The quick brown fox jumps over the lazy dog.' Do not change anything else.",
  replace: "In the self-test section, replace 'quick brown fox' with 'slow green turtle'.",
  format: "Make the words 'lazy dog' in the self-test section bold.",
  heading: "Make the line 'Self-test section' a level-2 heading (Heading 2). Do not change anything else.",
  list: "Turn the two paragraphs below the heading 'Self-test section' into a numbered list. Do not change their text.",
  replaceAll: "In the self-test section, replace every occurrence of 'turtle' with 'tortoise'.",
  selection: 'Rewrite the selected sentence in uppercase letters and replace it in the document.',
  question: 'How many lines does the self-test section have (heading and paragraphs)? Answer with the number only.',
  delete: 'Delete the self-test section: its heading and all its paragraphs.',
  insert: `Insert the following paragraph into the document: '${ST_PASTE_TEXT}'`,
  questionExport: "On which line of the document is the paragraph that starts with 'Self-test paragraph'? Answer with the line number only.",
  replaceSelection: "Replace the selected text with 'red cat'. Do not change anything else.",
};
// Lines the panel's cleanup may delete: only what the scenarios write.
const ST_TEST_LINE_RE = /self-test|quick brown fox|turtle|tortoise|lazy dog|red cat|^Item (?:one|two)$/i;
const stDelay = (ms) => new Promise((r) => setTimeout(r, ms));
const stTrim = (t) => String(t == null ? '' : t).trim();
const stSecs = (ms) => `${(ms / 1000).toFixed(1)} s`;

// The model phase. ctx.mp: { ready (the gate passed and a key is set), allowed (started), skipWhy, api (Docs
// API mode), T0 (the text before), sec (the section: before/after lines and its expected texts), broken (why
// the dependents are skipped), pasteLine (export mode), saved / savedSel (the chat history and selection to
// restore), stats, cleaned }.
// Whether the model scenarios can run (else mp.skipWhy): an API key (the gate checked the rest).
function stModelPossible(ctx) {
  const mp = ctx.mp;
  mp.api = ctx.mode === 'api';
  if (!activeConfig().apiKey) { mp.skipWhy = `not run: no ${activeProvider().label} API key`; return false; }
  return true;
}

// The start of the model phase, before its first scenario (after the write cycle): the document as it is
// now, the scratch history. Returns a failing row when the document cannot be read, else null.
async function stModelBegin(ctx) {
  const mp = ctx.mp;
  mp.ready = false;
  const first = await stReread(ctx, mp.api);
  if (!first.ok) { mp.skipWhy = 'not run: the document could not be read'; return stFail(first.error); }
  mp.allowed = true;
  mp.saved = state.messages;
  mp.savedSel = state.selection;
  mp.T0 = first.text;
  stModelStats(mp);
  return null;
}
// The provider and model of the Model line, and its start time (kept when a Your-turn scenario of the write
// cycle ran first).
function stModelStats(mp) {
  if (!mp.t0) mp.t0 = Date.now();
  const cfg = activeConfig();
  Object.assign(mp.stats, { provider: activeProvider().label, model: cfg.model || '(none)' });
}

const stLines = (text) => String(text).split('\n');

// Re-reads the document as a turn does (the selection left out) and returns a fresh turn snapshot:
// { ok, snap, text, lines (texts), error }. api: the read must come from the Docs API. Nothing was written
// since the last read (ctx.fresh): the snapshot is built from that read, without a request; force: read anyway
// (the export catching up with the editor).
async function stReread(ctx, api, { force = false } = {}) {
  const sel = state.selection;
  if (force || !ctx.fresh) {
    resetDocsApiTurn();
    await fetchDocText();
  }
  ctx.fresh = state.docText != null;
  const snap = takeSnapshot();
  state.selection = '';
  snapshotDocument(snap);
  state.selection = sel;
  snap.signal = ctx.signal;
  snap.chatCtx = { docId: state.docId, chatId: state.chatId, messages: [] };
  snap.mainUrl = ctx.tab.url;
  if (snap.docText == null) return { ok: false, error: `the document could not be read again: ${snap.docError || 'no text'}` };
  if (api && !snap.model) return { ok: false, error: 'the document could not be read again through the Docs API' };
  const text = api ? snap.model.text : snap.docText;
  return { ok: true, snap, text, lines: api ? snap.model.lines.map((l) => l.text) : docLines(snap) };
}

// One scenario: a quiet turn on a scratch history with its own timeout; Stop aborts it.
// Returns { loop, answer, error, timedOut, ms }; throws AbortError when the run was stopped.
async function stScenario(ctx, { prompt, mode = 'edit', selection = '' }) {
  const mp = ctx.mp;
  const ac = new AbortController();
  let timedOut = false;
  const onStop = () => ac.abort();
  ctx.signal.addEventListener('abort', onStop);
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, ST_MODEL.timeoutMs);
  const t0 = Date.now();
  const out = { loop: { rounds: 0, tools: [], usage: null, final: null }, answer: '', error: null, timedOut: false, ms: 0 };
  try {
    if (!ctx.fresh) { // the scenario's turn reads the document unless the last read is still current
      resetDocsApiTurn();
      await fetchDocText();
    }
    const snap = takeSnapshot();
    snap.signal = ac.signal;
    // The selection enters the snapshot the way a real one does (state.selection, which planApiSelection reads too).
    state.selection = selection;
    snapshotDocument(snap);
    snap.chatCtx = { docId: state.docId, chatId: state.chatId, messages: [] };
    snap.mainUrl = ctx.tab.url;
    if (snap.docText == null) throw new Error(snap.docError || 'the document text is unavailable');
    const userMsg = { role: 'user', content: prompt };
    const context = buildTurnContext(mode, snap, null);
    if (context) userMsg._context = context;
    const history = [userMsg];
    state.messages = history; // undo_last_edit and the reading tools see this scenario's journal only
    out.history = history;
    const label = snap.prov.label;
    try {
      out.loop = await toolLoop(mode, snap, ac.signal, {
        messages: history, quiet: true, request: { history },
        status: (t) => stLive(ctx, `${ctx.progress} · ${t}`), waiting: `waiting for ${label}…`,
      });
    } catch (e) {
      if (e.loop) out.loop = e.loop;
      out.error = e;
      mp.stats.requests++; // the failed request
    }
    const last = [...history].reverse().find((m) => m.role === 'assistant' && m.content);
    out.answer = stTrim(last ? last.content : (out.loop.final && out.loop.final.content) || '');
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener('abort', onStop);
    state.selection = '';
    ctx.fresh = false; // the model may have written
  }
  out.ms = Date.now() - t0;
  out.timedOut = timedOut && !ctx.signal.aborted;
  mp.stats.requests += out.loop.rounds;
  const u = out.loop.usage;
  if (u) { mp.stats.tokensIn += u.prompt_tokens || 0; mp.stats.tokensOut += u.completion_tokens || 0; mp.stats.usage = true; }
  mp.t1 = Date.now();
  if (ctx.signal.aborted) throw exportAbortError();
  return out;
}

// "read_lines ×2, insert_after_line ×1" (in the order of first use).
function stToolCounts(names) {
  if (!names.length) return 'no tool calls';
  const counts = new Map();
  for (const n of names) counts.set(n, (counts.get(n) || 0) + 1);
  return [...counts].map(([n, k]) => `${n} ×${k}`).join(', ');
}
const stTokens = (u) => (u ? `${fmtNum((u.prompt_tokens || 0) + (u.completion_tokens || 0))} tokens` : 'no usage reported');
const stAnswer = (run) => `«${stClip(run.answer, ST_ANSWER_CHARS) || '(empty)'}»`;

// The row of a scenario: the verdict plus rounds, tool calls and tokens; a failure adds the model's answer
// and what is left in the document.
async function stScenarioRow(ctx, run, verdict, extra = {}) {
  const facts = `${stPlural(run.loop.rounds, 'round')} · ${stToolCounts(run.loop.tools)} · ${stTokens(run.loop.usage)}`;
  const more = [verdict.more];
  let detail = `${verdict.detail} · ${facts}`;
  if (verdict.status === 'fail' || verdict.status === 'warn') {
    more.push(`Answer: ${stAnswer(run)}`);
    more.push(stToolTrace(run.history));
  }
  if (verdict.status === 'fail') {
    const left = await stModelLeftover(ctx);
    detail += ` · answer ${stAnswer(run)} · ${left}`;
    more.push(left);
  }
  return { ...verdict, ...extra, detail, more: more.filter(Boolean).join('\n') || undefined };
}
// The tool calls of a scenario's history for a failed or warned row: the name, the arguments as compact
// JSON (so "true" and true differ) and the first line of the result. Scenarios run quiet on a scratch
// history, so this is the only place the owner sees what the model actually sent.
const ST_TRACE_CALLS = 12;
const ST_TRACE_CHARS = 200;
function stToolTrace(history) {
  const results = new Map();
  const calls = [];
  for (const m of history || []) {
    if (m.role === 'tool') results.set(m.tool_call_id, String(m.content == null ? '' : m.content));
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) calls.push(...m.tool_calls);
  }
  if (!calls.length) return '';
  const rows = calls.slice(0, ST_TRACE_CALLS).map((c, i) => {
    const fn = c.function || {};
    let args = fn.arguments;
    try { args = JSON.stringify(typeof args === 'string' ? JSON.parse(args) : args); } catch (e) { /* not JSON: shown as sent */ }
    const res = results.has(c.id) ? results.get(c.id).split('\n')[0] : '(no result)';
    return `${i + 1}. ${fn.name}(${stClip(String(args == null ? '' : args), ST_TRACE_CHARS)}) → ${stClip(res, ST_TRACE_CHARS)}`;
  });
  const rest = calls.length > ST_TRACE_CALLS ? `\n… ${calls.length - ST_TRACE_CALLS} more` : '';
  return `Tool calls:\n${rows.join('\n')}${rest}`;
}
// The verdict of a run that did not finish (timeout or error), or null.
function stRunError(run) {
  if (run.timedOut) return stFail(`timed out after ${stSecs(ST_MODEL.timeoutMs)}`);
  if (run.error) return stFail(`the request failed: ${stClip(run.error.message || String(run.error), 160)}`);
  return null;
}

// Where the current lines differ from the original: the common head a and tail b, the extra lines of the
// current text (cur[a, n - b)) and the original lines they replace (t0[a, m - b)).
function stDiffLines(cur, t0) {
  let a = 0;
  while (a < cur.length && a < t0.length && cur[a] === t0[a]) a++;
  let b = 0;
  while (b < cur.length - a && b < t0.length - a && cur[cur.length - 1 - b] === t0[t0.length - 1 - b]) b++;
  return { a, b, extra: cur.slice(a, cur.length - b), missing: t0.slice(a, t0.length - b) };
}
const stLineRefs = (from, lines) => lines.map((t, i) => `line ${from + i} «${stClip(showText(t), 60)}»`).join(', ');

// The document is as before: "empty again" (what /test starts from), else "equals the original".
const stSame = (T0) => (stTrim(T0) ? 'the document equals the original' : 'the document is empty again');
const stCap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
// What of the model scenarios (or of the write cycle: api, T0) is left in the document (read again).
async function stModelLeftover(ctx, api = ctx.mp.api, T0 = ctx.mp.T0) {
  const r = await stReread(ctx, api);
  if (!r.ok) return `The document could not be read again (${r.error}); compare it with the original by hand.`;
  if (r.text === T0) return `${stCap(stSame(T0))}.`;
  const d = stDiffLines(r.lines, stLines(T0));
  const parts = [];
  if (d.extra.length) parts.push(`Left in the document: ${stLineRefs(d.a + 1, d.extra)}.`);
  if (d.missing.length) parts.push(`Original lines changed or removed: ${stLineRefs(d.a + 1, d.missing)}.`);
  if (!parts.length) parts.push('The document differs from the original in whitespace only.');
  return parts.join(' ');
}

// The section as expected after a scenario: the lines before and after it unchanged, its lines (trimmed)
// equal to want. Returns null when it matches, else what differs.
function stSectionDiff(mp, lines, want) {
  const { before, after } = mp.sec;
  if (lines.length !== before.length + want.length + after.length) {
    return `the document has ${stPlural(lines.length, 'line')}, expected ${before.length + want.length + after.length}`;
  }
  for (let i = 0; i < before.length; i++) if (lines[i] !== before[i]) return `line ${i + 1} outside the section changed: ${stQuote(lines[i])}`;
  for (let i = 0; i < after.length; i++) {
    const k = before.length + want.length + i;
    if (lines[k] !== after[i]) return `line ${k + 1} outside the section changed: ${stQuote(lines[k])}`;
  }
  for (let i = 0; i < want.length; i++) {
    const got = stTrim(lines[before.length + i]);
    if (got !== stTrim(want[i])) return `line ${before.length + i + 1} reads ${stQuote(got)}, expected ${stQuote(want[i])}`;
  }
  return null;
}
const stSecLine = (mp, k) => mp.sec.before.length + 1 + k; // document line of section line k (0-based)
const stSecRange = (mp) => `lines ${stSecLine(mp, 0)}–${stSecLine(mp, mp.sec.want.length - 1)}`;

// A model-scenario step: skipped when the gate stopped the run or no key is set, (dependent) once an earlier
// scenario broke the section; the first one starts the phase (stModelBegin). api: needs the Docs API.
function stModelStep(fn, { api = false, dependent = true } = {}) {
  return async (ctx) => {
    const mp = ctx.mp;
    if (!mp.allowed) {
      if (!mp.ready) return stSkip(mp.skipWhy || 'not run');
      const failed = await stModelBegin(ctx);
      if (failed) return failed;
    }
    if (api && !mp.api) return stNeedsApi();
    if (dependent && mp.broken) return stSkip(`not run: ${mp.broken}`);
    try { return await fn(ctx, mp); } catch (e) {
      if (ctx.signal.aborted || e.name === 'AbortError') throw e;
      return stFail(e.message || String(e));
    }
  };
}

// 1 (Docs API). The model writes the section at the end; its lines are recorded for the later scenarios.
async function stModelWriteApi(ctx, mp) {
  const run = await stScenario(ctx, { prompt: ST_PROMPTS.write });
  const r = await stReread(ctx, true);
  const verdict = stRunError(run) || (!r.ok ? stFail(r.error) : stCheckSection(mp, r));
  if (verdict.status === 'fail') mp.broken = 'the model did not write the self-test section';
  return stScenarioRow(ctx, run, verdict);
}
function stCheckSection(mp, r) {
  const lines = r.lines;
  const idx = [];
  for (let i = lines.length - 1; i >= 0 && idx.length < 2; i--) if (stTrim(lines[i])) idx.unshift(i);
  const [h, p] = idx;
  const headOk = h != null && stTrim(lines[h]).replace(/^#+\s*/, '') === ST_SECTION.heading;
  if (h == null || p !== h + 1 || !headOk || stTrim(lines[p]) !== ST_SECTION.para) {
    return stFail(`the last two lines are not «${ST_SECTION.heading}» and the fox paragraph`,
      `Last lines: ${lines.slice(-3).map((t) => stQuote(t)).join(', ') || '(none)'}`);
  }
  const before = lines.slice(0, h);
  const after = lines.slice(p + 1);
  mp.sec = { before, after, want: [lines[h], ST_SECTION.para] };
  const rest = [...before, ...after];
  const t0 = stLines(mp.T0);
  const where = `lines ${h + 1}–${p + 1} read «${ST_SECTION.heading}» / ${stQuote(ST_SECTION.para)}`;
  if (rest.join('\n') === t0.join('\n')) {
    return stTrim(lines[h]) === ST_SECTION.heading ? stPass(where) : stWarn(`${where} (the heading has a Markdown "#")`);
  }
  if (rest.filter((t) => stTrim(t)).join('\n') === t0.filter((t) => stTrim(t)).join('\n')) {
    return stWarn(`${where}; empty lines were added or removed elsewhere`);
  }
  mp.sec = null;
  const d = stDiffLines(rest, t0);
  return stFail(`${where}, but other lines changed`, `Changed: ${stLineRefs(d.a + 1, d.extra)}; original: ${stLineRefs(d.a + 1, d.missing)}`);
}

// A text scenario on the section: the model's turn, then the section must read want.
async function stModelEdit(ctx, mp, prompt, want, opts = {}) {
  const run = await stScenario(ctx, { prompt, ...opts });
  const r = await stReread(ctx, true);
  let verdict = stRunError(run) || (!r.ok ? stFail(r.error) : null);
  if (!verdict) {
    const diff = stSectionDiff(mp, r.lines, want);
    verdict = diff ? stFail(diff) : stPass(`${stSecRange(mp)} read ${want.slice(1).map((t) => stQuote(t)).join(' / ')}`);
  }
  if (verdict.status === 'fail') mp.broken = 'an earlier scenario changed the section unexpectedly';
  else mp.sec.want = want;
  return { run, r, verdict };
}

const stModelReplace = stModelStep(async (ctx, mp) => {
  const want = [mp.sec.want[0], 'The slow green turtle jumps over the lazy dog.'];
  const { run, verdict } = await stModelEdit(ctx, mp, ST_PROMPTS.replace, want);
  return stScenarioRow(ctx, run, verdict);
}, { api: true });

const stModelFormat = stModelStep(async (ctx, mp) => {
  const { run, r, verdict } = await stModelEdit(ctx, mp, ST_PROMPTS.format, mp.sec.want.slice());
  if (verdict.status !== 'pass') return stScenarioRow(ctx, run, verdict);
  const first = stSecLine(mp, 0);
  const last = stSecLine(mp, mp.sec.want.length - 1);
  const f = await stTool(ctx, 'read_formatting', { start: first, end: last }, r.snap);
  const line = f.content.split('\n').find((l) => l.startsWith(`${first + 1}: `)) || '';
  const bold = (/\*\*([^*]+)\*\*/.exec(line) || [])[1];
  let v;
  if (bold === 'lazy dog') v = stPass(`read_formatting shows line ${first + 1} with **lazy dog**`);
  else if (bold && bold.includes('lazy dog')) v = stWarn(`the bold text is «${stClip(bold)}», wider than «lazy dog»`);
  else v = stFail('read_formatting does not show «lazy dog» as bold', stClip(f.content, ST_FORMAT_CHARS));
  return stScenarioRow(ctx, run, v);
}, { api: true });

// The heading line becomes Heading 2 (format_lines): its text unchanged, its style HEADING_2 and [h2] in read_formatting.
// Another heading level (or other formatting too) is a warning, no heading a failure.
const stModelHeading = stModelStep(async (ctx, mp) => {
  const { run, r, verdict } = await stModelEdit(ctx, mp, ST_PROMPTS.heading, mp.sec.want.slice());
  if (verdict.status !== 'pass') return stScenarioRow(ctx, run, verdict);
  const k = stSecLine(mp, 0);
  const line = r.snap.model.lines[k - 1];
  const f = await stTool(ctx, 'read_formatting', { start: k, end: k }, r.snap);
  const got = stLineOf(f, k);
  const style = line.style || 'NORMAL_TEXT';
  let v;
  if (style === 'HEADING_2' && got === `${k}: [h2] ${showText(line.text)}`) v = stPass(`line ${k} is Heading 2: read_formatting shows ${stQuote(got)}`);
  else if (style === 'HEADING_2') v = stWarn(`line ${k} is Heading 2, but other formatting changed too: ${stClip(got, 80)}`, stClip(f.content, ST_FORMAT_CHARS));
  else if (line.heading) v = stWarn(`line ${k} is ${style}, not HEADING_2`, stClip(f.content, ST_FORMAT_CHARS));
  else v = stFail(`line ${k} is not a heading (${style})`, stClip(f.content, ST_FORMAT_CHARS));
  return stScenarioRow(ctx, run, v);
}, { api: true });

// The two paragraphs become a numbered list (format_lines): text unchanged ("1." typed into the text fails in
// stModelEdit), both lines numbered, the heading not in a list. A bulleted or checklist list is a warning.
const stModelNumbered = stModelStep(async (ctx, mp) => {
  const { run, r, verdict } = await stModelEdit(ctx, mp, ST_PROMPTS.list, mp.sec.want.slice());
  if (verdict.status !== 'pass') return stScenarioRow(ctx, run, verdict);
  const nums = mp.sec.want.map((_, i) => stSecLine(mp, i));
  const lines = nums.map((n) => r.snap.model.lines[n - 1]);
  const kinds = lines.slice(1).map((l) => (l.list ? l.list.kind : 'none'));
  const f = await stTool(ctx, 'read_formatting', { start: nums[0], end: nums[nums.length - 1] }, r.snap);
  const where = `lines ${nums[1]}–${nums[nums.length - 1]}`;
  let v;
  if (lines[0].list) v = stFail(`the heading (line ${nums[0]}) is in a list too (${lines[0].list.kind})`, stClip(f.content, ST_FORMAT_CHARS));
  else if (kinds.every((k) => k === 'number')) v = stPass(`${where} are a numbered list; the heading is not in it`);
  else if (kinds.every((k) => k !== 'none')) v = stWarn(`${where} are a list, but ${kinds.join(' / ')} instead of numbered`, stClip(f.content, ST_FORMAT_CHARS));
  else v = stFail(`${where} are not a list (${kinds.join(' / ')})`, stClip(f.content, ST_FORMAT_CHARS));
  return stScenarioRow(ctx, run, v);
}, { api: true });

const stModelReplaceAll = stModelStep(async (ctx, mp) => {
  // The panel adds the second paragraph itself (insert_after_line through the same write code).
  const pLine = stSecLine(mp, 1);
  const cur = await stReread(ctx, true);
  if (!cur.ok) { mp.broken = 'the document could not be read again'; return stFail(cur.error); }
  const ins = await stTool(ctx, 'insert_after_line', { line: pLine, text: ST_SECTION.extra }, cur.snap);
  if (!ins._ok) { mp.broken = 'the panel could not add the second paragraph'; return stFail(`insert_after_line failed: ${stClip(ins._message || ins.content, 160)}`); }
  mp.sec.want = [...mp.sec.want, ST_SECTION.extra];
  const want = [mp.sec.want[0], 'The slow green tortoise jumps over the lazy dog.', 'A tortoise is a tortoise.'];
  const { run, verdict } = await stModelEdit(ctx, mp, ST_PROMPTS.replaceAll, want);
  const v = verdict.status === 'pass' ? stPass(`the panel added «${ST_SECTION.extra}» as line ${pLine + 1}; all 3 «turtle» became «tortoise», nothing else changed`) : verdict;
  return stScenarioRow(ctx, run, v);
}, { api: true });

const stModelSelection = stModelStep(async (ctx, mp) => {
  const k = stSecLine(mp, 1);
  const sel = stTrim(mp.sec.want[1]);
  const want = [mp.sec.want[0], sel.toUpperCase(), ...mp.sec.want.slice(2)];
  const { run, verdict } = await stModelEdit(ctx, mp, ST_PROMPTS.selection, want, { selection: sel });
  const note = `selection simulated: the panel set the turn's selection to line ${k} (Docs cannot be selected programmatically)`;
  const v = verdict.status === 'pass' ? stPass(`line ${k} is uppercase · ${note}`) : { ...verdict, detail: `${verdict.detail} · ${note}` };
  return stScenarioRow(ctx, run, v);
}, { api: true });

// A question in Manual mode: the answer must contain the number, and the model should have read the document.
async function stModelAsk(ctx, prompt, want) {
  const run = await stScenario(ctx, { prompt, mode: 'manual' });
  const err = stRunError(run);
  if (err) return stScenarioRow(ctx, run, err);
  const nums = (run.answer.match(/\d+/g) || []).map(Number);
  const read = run.loop.tools.some((n) => READING_TOOLS.includes(n) || n === FORMAT_READING_TOOL);
  let v;
  if (!nums.includes(want)) v = stFail(`the answer does not contain ${want}`);
  else if (!read) v = stWarn(`answered ${want} without calling a reading tool (guessed from the context)`);
  else v = stPass(`answered ${want} (correct) after reading`);
  return stScenarioRow(ctx, run, v);
}

const stModelQuestion = stModelStep(async (ctx, mp) => {
  if (!mp.api) {
    if (!mp.pasteLine) return stSkip('not run: the test paragraph was not inserted');
    return stModelAsk(ctx, ST_PROMPTS.questionExport, mp.pasteLine);
  }
  return stModelAsk(ctx, ST_PROMPTS.question, mp.sec.want.length);
});

const stModelDelete = stModelStep(async (ctx, mp) => {
  if (!mp.sec) return stSkip('not run: there is no self-test section');
  const run = await stScenario(ctx, { prompt: ST_PROMPTS.delete });
  const r = await stReread(ctx, true);
  let v = stRunError(run) || (!r.ok ? stFail(r.error) : null);
  if (!v) v = r.text === mp.T0 ? stPass(stSame(mp.T0)) : stFail(`the document differs from the original${stTrim(mp.T0) ? '' : ' (it is not empty)'}`);
  return stScenarioRow(ctx, run, v);
}, { api: true, dependent: false });

// The last step (also after Stop): the document must be as before (empty). With the Docs API the panel
// deletes lines the scenarios left behind (only added lines that look like test text).
async function stModelCleanup(ctx) {
  const mp = ctx.mp;
  mp.cleaned = true;
  return stRestore(ctx, mp.api, mp.T0);
}
// The panel's cleanup (the model scenarios', or the write cycle's after Stop): the document re-read and
// compared with T0, the test lines deleted through the Docs API.
async function stRestore(ctx, api, T0) {
  const r = await stReread(ctx, api);
  if (!r.ok) return stFail(r.error);
  if (r.text === T0) return stPass(stSame(T0));
  const d = stDiffLines(r.lines, stLines(T0));
  if (!api) return stPasteStays(d);
  const removable = !d.missing.length && d.extra.length && d.extra.every((t) => !stTrim(t) || ST_TEST_LINE_RE.test(t)) && d.extra.some((t) => stTrim(t));
  if (!removable) {
    const left = await stModelLeftover(ctx, api, T0);
    return stFail(`the panel cannot restore this safely · ${left}`);
  }
  const from = d.a + 1;
  const to = d.a + d.extra.length;
  const del = await stTool(ctx, 'delete_lines', { start: from, end: to }, r.snap);
  const again = await stReread(ctx, true);
  if (del._ok && again.ok && again.text === T0) return stPass(`cleaned up by the panel: deleted lines ${from}–${to}; ${stSame(T0)}`);
  const left = await stModelLeftover(ctx, api, T0);
  return stFail(`the panel's cleanup did not restore the document${del._ok ? '' : ` (${stClip(del._message || del.content, 120)})`} · ${left}`);
}
// Without the Docs API: the warning that the test text stays (d: stDiffLines of the document and T0).
function stPasteStays(d) {
  const left = d.extra.length ? stLineRefs(d.a + 1, d.extra) : 'changes';
  return stWarn(`the test paragraph stays in the document (${left}): press Ctrl+Z in Google Docs to remove it (without the Docs API the panel cannot delete it)`);
}
const stModelCleanupStep = async (ctx) => {
  if (!ctx.mp.allowed) return stSkip(ctx.mp.skipWhy || 'not run');
  return stModelCleanup(ctx);
};

// How many times needle occurs in hay (both compared loosely, stLoose; non-overlapping).
function stCount(hay, needle) {
  const h = stLoose(hay);
  const n = stLoose(needle);
  if (!n) return 0;
  let k = 0;
  for (let at = h.indexOf(n); at >= 0; at = h.indexOf(n, at + n.length)) k++;
  return k;
}
// The replace_selection calls of a scenario (from its history), in order: [{ text, attempts, pasted, refused }].
// text: what the model sent (null: invalid arguments); attempts: the insertion attempts the content script
// reported (null: not reported); pasted: the call pasted (ok, not refused); refused: the panel refused a second
// paste in the turn (runToolCall, _pasteRefused).
function stPasteCalls(run) {
  const name = REPLACE_TOOL.function.name;
  const calls = new Map();
  for (const m of run.history || []) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (!tc.function || tc.function.name !== name) continue;
        const { args } = parseToolArgs(tc);
        calls.set(tc.id, { text: typeof args.text === 'string' ? args.text : null, attempts: null, pasted: false, refused: false });
      }
    } else if (m.role === 'tool' && calls.has(m.tool_call_id)) {
      const c = calls.get(m.tool_call_id);
      if (Number.isFinite(m._attempts)) c.attempts = m._attempts;
      c.refused = !!m._pasteRefused;
      c.pasted = !!m._ok && !c.refused;
    }
  }
  return [...calls.values()];
}
// "65 characters each" (all calls the same length) or "65 and 70 characters".
function stCallChars(calls) {
  const n = calls.map((c) => (c.text || '').length);
  if (n.every((k) => k === n[0])) return `${stPlural(n[0], 'character')}${n.length > 1 ? ' each' : ''}`;
  return `${n.slice(0, -1).map(fmtNum).join(', ')} and ${fmtNum(n[n.length - 1])} characters`;
}
// The paste's facts for the row: "text 65 characters · pasted once · 1 call · 1 insertion attempt", or the
// failure when the paragraph is in the document more than once, with who repeated it: the model calling
// replace_selection several times (a model behavior failure), the model's text holding the paragraph several
// times, or the content script inserting one call several times. A second call the panel refused (one paste
// per turn) is a warning detail, not a failure: { fail, detail, refused }.
function stPasteVerdict(run, docText) {
  const calls = stPasteCalls(run);
  const pasted = calls.filter((c) => c.pasted);
  const refused = calls.filter((c) => c.refused).length;
  const inDoc = stCount(docText, ST_PASTE_TEXT);
  const reported = calls.filter((c) => c.attempts != null);
  const attempts = reported.reduce((k, c) => k + c.attempts, 0);
  const facts = [stPlural(calls.length, 'call')];
  if (reported.length) facts.push(stPlural(attempts, 'insertion attempt'));
  if (refused) facts.push(refused === 1 ? 'second call refused by the panel' : `${fmtNum(refused)} further calls refused by the panel`);
  const tail = ` · ${facts.join(' · ')}`;
  if (inDoc > 1) {
    const why = [];
    if (pasted.length > 1) {
      why.push(`the model called replace_selection ${pasted.length} times (${stCallChars(pasted)}); each call was pasted once (a model behavior failure)`);
    }
    const inText = Math.max(0, ...pasted.map((c) => stCount(c.text || '', ST_PASTE_TEXT)));
    if (inText > 1) why.push(`the model sent the paragraph ${inText} times (one call, ${stPlural(pasted.find((c) => stCount(c.text || '', ST_PASTE_TEXT) === inText).text.length, 'character')})`);
    const many = Math.max(0, ...pasted.map((c) => c.attempts || 0));
    if (many > 1) why.push(`the content script inserted ${many} times for one call`);
    if (!why.length) why.push(`the paste was inserted ${inDoc} times`);
    return { fail: true, refused, detail: `pasted ${inDoc} times: ${why.join('; ')}${tail}` };
  }
  const first = pasted[0] || calls[0];
  const sent = first && first.text != null ? `text ${stPlural(first.text.length, 'character')} · ` : '';
  return { fail: false, refused, detail: `${sent}pasted once${tail}` };
}

// 1 without the Docs API: the paste at the cursor through replace_selection, checked in the export (the
// paragraph exactly once: a paste inserted twice fails); the reading checks then run on that paragraph
// (ctx.content), on whatever is there.
async function stModelInsert(ctx, mp) {
  const run = await stScenario(ctx, { prompt: ST_PROMPTS.insert });
  let v = stRunError(run);
  let r = null;
  let line = 0;
  if (!v) {
    // The export follows the editor after Docs saved the change: try a few times.
    for (let i = 0; i < ST_MODEL.exportTries; i++) {
      if (i) await stDelay(ST_MODEL.exportWaitMs);
      r = await stReread(ctx, false, { force: i > 0 });
      line = r.ok ? r.lines.findIndex((t) => stLoose(t).includes(stLoose(ST_PASTE_TEXT))) + 1 : 0;
      if (line) break;
    }
    const pasted = run.loop.tools.includes(REPLACE_TOOL.function.name);
    if (!r.ok) v = stFail(r.error);
    else if (!line) v = stFail(pasted ? 'replace_selection ran, but the paragraph is not in the export' : 'the model did not call replace_selection; the paragraph is not in the document');
    else if (!pasted) v = stWarn(`the paragraph is on line ${line}, but the model did not use replace_selection`);
    else {
      const p = stPasteVerdict(run, r.text);
      v = p.fail ? stFail(p.detail) : stPass(`replace_selection pasted it where the cursor was; the export shows it on line ${line} · ${p.detail}`);
    }
  }
  if (line) {
    mp.pasteLine = line;
    ctx.content = { snap: r.snap, line, text: r.lines[line - 1], api: false };
    Object.assign(ctx.it, { ready: true, api: false, line, text: r.lines[line - 1] });
  } else {
    mp.broken = 'the test paragraph was not inserted';
  }
  return stScenarioRow(ctx, run, v);
}

const stModelWrite = stModelStep(async (ctx, mp) => (mp.api ? stModelWriteApi(ctx, mp) : stModelInsert(ctx, mp)), { dependent: false });

// ---- Your turn: steps the user does by hand ---------------------------------------------------------
// Docs cannot be selected or formatted by the panel without the API, so /test asks the user: a "Your turn"
// card (confirmYourTurn: Continue / Skip; Stop ends the wait; no answer within ST_INTERACTIVE.timeoutMs counts
// as Skip), then the panel reads the document again and checks what the user did. They run on the test
// paragraph (ctx.it: { ready, api, line, text }): the one the model pasted (export mode) or the write cycle's
// (Docs API mode; stHandRewriteApi writes it again afterwards). ctx.it also keeps shown (a card was shown or
// the model replaced the selection), selected / selection (the select step passed and what it read) and
// selectWhy (why the replace step does not run).
const ST_INTERACTIVE = { timeoutMs: 3 * 60 * 1000 }; // tests use the sandbox timers
const ST_YOUR_TURN = {
  select: 'In the document, select the words «brown fox» in the test paragraph, then click Continue.',
  bold: 'Select the word «quick» in the test paragraph and press Ctrl+B (make it bold), then click Continue.',
  remove: 'Remove the test paragraph: press Ctrl+Z until it is gone, or select it and press Delete, then click Continue.',
  typing: 'Click at the end of the test paragraph and type a few letters (no Enter). Wait about 5 seconds, delete them, then click Continue.',
};
const ST_HAND = { select: 'brown fox', replace: 'red cat', bold: 'quick' };
const ST_BY_USER = 'skipped by the user';
const ST_TIMED_OUT = `${ST_BY_USER} (no answer within ${ST_INTERACTIVE.timeoutMs / 60000} minutes)`;

// Shows the card and waits. Returns { go: true } on Continue, else { go: false, why } (Skip, the timeout);
// Stop throws an AbortError. Afterwards the last read is stale (the user may have edited the document).
// showSelection: the card shows what the panel sees selected (the steps that ask the user to select text).
async function stYourTurn(ctx, text, { showSelection = false, timeoutMs = ST_INTERACTIVE.timeoutMs } = {}) {
  ctx.it.shown = true;
  stLive(ctx, `${ctx.progress} · your turn (see the card below)`, 'wave');
  let d;
  try { d = await confirmYourTurn(text, ctx.signal, { timeoutMs, showSelection }); } finally { stLive(ctx, ctx.progress); }
  ctx.fresh = false;
  if (d === 'stop' || ctx.signal.aborted) throw exportAbortError();
  if (d === 'continue') return { go: true };
  return { go: false, timedOut: d === 'timeout', why: d === 'timeout' ? ST_TIMED_OUT : ST_BY_USER };
}

// A Your-turn row: skipped when there is no test paragraph (the reading checks' reason).
function stHandStep(fn) {
  return async (ctx) => {
    if (!ctx.it.ready) return stSkip(ctx.contentWhy || 'not run: there is no test paragraph');
    try { return await fn(ctx, ctx.it); } catch (e) {
      if (ctx.signal.aborted || e.name === 'AbortError') throw e;
      return stFail(e.message || String(e));
    }
  };
}

// 1. The user selects «brown fox»; the panel reads the selection the way a turn does (refreshSelection:
// GET_SELECTION, live or from the content script's cache). The panel's own selection is left as it was.
const stHandSelect = stHandStep(async (ctx, it) => {
  it.selectWhy = 'the selection step did not pass';
  const t = await stYourTurn(ctx, ST_YOUR_TURN.select, { showSelection: true });
  if (!t.go) { it.selectWhy = `the selection step was ${t.why}`; return stSkip(t.why); }
  const saved = state.selection;
  const r = await refreshSelection();
  state.selection = saved;
  renderSelection();
  if (r.error) return stFail(`could not read the selection: ${r.error}`);
  const how = r.cached ? 'cached' : 'live';
  const got = stTrim(r.text);
  const read = got ? `read ${stQuote(got)} (${how})` : `nothing selected (${how} read)`;
  if (got !== ST_HAND.select && stLoose(got) !== ST_HAND.select) return stFail(`${read}, expected «${ST_HAND.select}»`);
  it.selected = true;
  it.selection = got;
  return stPass(got === ST_HAND.select ? read : `${read}: «${ST_HAND.select}» after the panel's cleaning`);
});

// 2. The model replaces the real selection (Auto mode, the selection in the turn snapshot as a turn takes it):
// through the Docs API (planApiSelection) or the paste with the expected selection (REPLACE_SELECTION.expected).
// Verified by reading again, relative to the document right before the step (an earlier failure may have left
// extra copies of the paragraph): «brown fox» once fewer, «red cat» once more, the rest of the line unchanged.
const stHandReplace = stHandStep(async (ctx, it) => {
  const mp = ctx.mp;
  if (!it.selected) return stSkip(`not run: ${it.selectWhy || 'the selection step did not run'}`);
  if (!mp.allowed && !mp.ready) return stSkip(mp.skipWhy || 'not run');
  if (!mp.allowed) { stModelStats(mp); if (mp.T0 == null) mp.T0 = ctx.phase.T0; } // in the write cycle: its empty start
  it.shown = true;
  // The document right before the step; the scenario's turn reuses this read (ctx.fresh). Unreadable: the
  // counts of a clean test paragraph (one «brown fox», no «red cat»).
  const pre = await stReread(ctx, it.api);
  const had = pre.ok ? { select: stCount(pre.text, ST_HAND.select), replace: stCount(pre.text, ST_HAND.replace) } : { select: 1, replace: 0 };
  const saved = state.messages; // the write cycle's journal (Docs API mode) stays the journal
  let run;
  try { run = await stScenario(ctx, { prompt: ST_PROMPTS.replaceSelection, selection: it.selection }); } finally { state.messages = saved; }
  const want = it.text.replace(ST_HAND.select, ST_HAND.replace);
  let v = stRunError(run);
  if (!v) {
    let r = null;
    let ok = false;
    const tries = it.api ? 1 : ST_MODEL.exportTries; // the export follows the editor after Docs saved
    for (let i = 0; i < tries && !ok; i++) {
      if (i) await stDelay(ST_MODEL.exportWaitMs);
      r = await stReread(ctx, it.api, { force: i > 0 });
      ok = r.ok && stCount(r.text, ST_HAND.replace) === had.replace + 1 && stCount(r.text, ST_HAND.select) === had.select - 1;
    }
    const used = run.loop.tools.includes(REPLACE_TOOL.function.name);
    const how = it.api ? 'the Docs API' : 'the paste over the selection';
    if (!r.ok) v = stFail(r.error);
    else if (!ok) {
      const before = had.select === 1 && had.replace === 0 ? ''
        : ` (before the step: «${ST_HAND.replace}» ${stPlural(had.replace, 'time')} and «${ST_HAND.select}» ${stPlural(had.select, 'time')})`;
      v = stFail(`the document has «${ST_HAND.replace}» ${stPlural(stCount(r.text, ST_HAND.replace), 'time')} and «${ST_HAND.select}» ${stPlural(stCount(r.text, ST_HAND.select), 'time')}` +
        before + (used ? '' : '; the model did not call replace_selection'));
    } else {
      const k = r.lines.findIndex((t) => stLoose(t).includes(ST_HAND.replace)) + 1;
      const where = `line ${k} reads ${stQuote(r.lines[k - 1])}`;
      if (!used) v = stWarn(`${where}, but the model did not use replace_selection`);
      else if (stLoose(r.lines[k - 1]) !== stLoose(want)) v = stWarn(`«${ST_HAND.select}» became «${ST_HAND.replace}», but the line changed otherwise: ${where}`, `Expected: ${stQuote(want)}`);
      else v = stPass(`replace_selection replaced the selection «${it.selection}» through ${how}; ${where}`);
    }
    if (r.ok) it.text = r.lines[it.line - 1] || it.text;
  }
  return stScenarioRow(ctx, run, v);
});

// 3. The user makes «quick» bold. With the Docs API read_formatting must show **quick** on the paragraph's
// line; without it the Markdown export (the panel keeps its **bold** markers in the document text).
const stHandBold = stHandStep(async (ctx, it) => {
  const t = await stYourTurn(ctx, ST_YOUR_TURN.bold, { showSelection: true });
  if (!t.go) return stSkip(t.why);
  const lineOf = (lines) => lines.findIndex((x) => /lazy dog/i.test(x)) + 1; // the paragraph, whatever replaced «brown fox»
  const verdict = (text, where) => {
    if (/\*\*quick\*\*/i.test(text)) return { status: 'pass', text: `${where} shows **${ST_HAND.bold}**` };
    const bold = (/\*\*([^*]*quick[^*]*)\*\*/i.exec(text) || [])[1];
    if (bold) return { status: 'warn', text: `${where}: the bold text is ${stQuote(bold)}, wider than «${ST_HAND.bold}»` };
    return { status: 'fail', text: `${where} does not show «${ST_HAND.bold}» as bold` };
  };
  if (it.api) {
    let v = null;
    let f = null;
    let n = 0;
    while (n < ST_MODEL.apiTries) {
      if (n) await stDelay(ST_MODEL.apiWaitMs);
      const r = await stReread(ctx, true, { force: n > 0 });
      n++;
      if (!r.ok) return stFail(r.error);
      const k = lineOf(r.lines);
      if (!k) return stFail('the test paragraph is no longer in the document');
      f = await stTool(ctx, 'read_formatting', { start: k, end: k }, r.snap);
      const got = f.content.split('\n').find((l) => l.startsWith(`${k}: `)) || '';
      v = verdict(got, `read_formatting of line ${k}`);
      if (v.status === 'pass') break;
    }
    return stResult(v.status)(`${v.text} (after ${stPlural(n, 'read')})`, v.status === 'pass' ? '' : stClip(f.content, ST_FORMAT_CHARS));
  }
  let r = null;
  let v = null;
  for (let i = 0; i < ST_MODEL.exportTries; i++) {
    if (i) await stDelay(ST_MODEL.exportWaitMs);
    r = await stReread(ctx, false, { force: i > 0 });
    if (!r.ok) return stFail(r.error);
    if (r.snap.docFormat !== 'markdown') return stWarn('the export is plain text, so the formatting cannot be read without the Docs API');
    const k = lineOf(r.lines);
    if (!k) return stFail('the test paragraph is no longer in the document');
    v = verdict(r.lines[k - 1], `the Markdown export of line ${k}`);
    if (v.status === 'pass') break;
  }
  return stResult(v.status)(`${v.text} (formatting read from the Markdown export)`);
});

// 4. The typing signal: the user types a few letters and deletes them; the panel counts what the content script
// sends meanwhile (DOC_TYPED, DOC_CHANGED by source, through setDocSignalTap) and, from the first signal on, reads the
// way the live line does (the Docs API revision every ST_SIGNAL.apiEveryMs; the export every ST_SIGNAL.exportEveryMs,
// at most ST_SIGNAL.exportTries times) until a read differs from the one before the step. Waits ST_SIGNAL.timeoutMs
// for Continue; no Continue by then still reports what arrived. The letters left in the document go with the
// paragraph (Docs API: stHandRewriteApi writes it again; export: the user removes it at the end).
const ST_SIGNAL = { timeoutMs: 60000, apiEveryMs: 1000, apiTries: 30, exportEveryMs: 3000, exportTries: 4 }; // tests shorten these
async function stWatchExact(ctx, api, base, seen, signal) {
  const every = api ? ST_SIGNAL.apiEveryMs : ST_SIGNAL.exportEveryMs;
  const tries = api ? ST_SIGNAL.apiTries : ST_SIGNAL.exportTries;
  for (let i = 0; i < tries && !signal.aborted; i++) {
    await stDelay(every);
    if (signal.aborted) return;
    try {
      const changed = api ? (await fetchDocRevision(state.docId)) !== base.rev
        : (await readExport(ctx.tab, () => {}, { signal })).text !== base.text;
      if (changed) { seen.readMs = Date.now() - seen.first; return; }
    } catch (e) {
      if (signal.aborted) return;
      seen.readError = e.message || String(e);
      return;
    }
  }
}
const stHandTyping = stHandStep(async (ctx, it) => {
  const pre = await stReread(ctx, it.api);
  if (!pre.ok) return stFail(pre.error);
  const base = { text: pre.text, rev: it.api ? pre.snap.model.revisionId : null };
  const seen = { typed: 0, changed: 0, page: 0, input: 0, remote: 0, plus: 0, minus: 0, first: 0, readMs: null, readError: '' };
  const stop = new AbortController();
  let watching = null;
  setDocSignalTap((msg) => {
    if (!seen.first) { seen.first = Date.now(); watching = stWatchExact(ctx, it.api, base, seen, stop.signal); }
    if (msg.type === 'DOC_TYPED') {
      seen.typed++;
      const d = Number(msg.dChars) || 0;
      if (d > 0) seen.plus += d; else seen.minus -= d;
    } else {
      seen.changed++;
      if (msg.source === 'page') seen.page++; else seen.input++;
      if (msg.remote) seen.remote++;
    }
  });
  let t;
  try { t = await stYourTurn(ctx, ST_YOUR_TURN.typing, { timeoutMs: ST_SIGNAL.timeoutMs }); } finally {
    setDocSignalTap(null);
    stop.abort();
  }
  if (watching) await watching;
  if (!seen.typed && !seen.changed && !t.go && !t.timedOut) return stSkip(t.why);
  return stTypingVerdict(seen, it.api, t.timedOut);
});

// The row of the typing signal: what arrived, the estimate, when a read saw the change.
function stTypingVerdict(seen, api, timedOut) {
  const est = [seen.plus ? `+${fmtNum(seen.plus)}` : '', seen.minus ? `−${fmtNum(seen.minus)}` : ''].filter(Boolean).join(' ') || '0';
  const sources = seen.changed ? ` (page ${fmtNum(seen.page)}${seen.remote ? `, ${fmtNum(seen.remote)} of them remote` : ''}, input ${fmtNum(seen.input)})` : '';
  const read = seen.readMs != null ? `exact read after ${(seen.readMs / 1000).toFixed(1)} s`
    : seen.readError ? `the read failed: ${seen.readError}`
      : `no ${api ? 'Docs API' : 'export'} read saw the change`;
  const detail = `DOC_TYPED ×${fmtNum(seen.typed)}, DOC_CHANGED ×${fmtNum(seen.changed)}${sources}, estimate ${est} chars, ${read}` +
    (timedOut ? ` (no Continue within ${ST_SIGNAL.timeoutMs / 1000} s)` : '');
  if (!seen.typed && !seen.changed) return stFail(`nothing arrived from the content script${timedOut ? ` within ${ST_SIGNAL.timeoutMs / 1000} s` : ''}: the panel does not see typing in this tab; reload the Docs tab and run /test again`);
  if (!seen.typed) return stWarn(`${detail}: no DOC_TYPED, so the numbers wait for the read`);
  if (!seen.changed) return stWarn(`${detail}: no DOC_CHANGED, so the read waits for the 15 s check`);
  if (seen.readMs == null) return stWarn(detail);
  return stPass(detail);
}

// 5. Without the Docs API (export mode) the cleanup is the user's: the test paragraph removed by hand, the
// document read again and compared with the start (empty). Skip (or the timeout) gives the warning the
// panel's cleanup gave before; with no test paragraph the panel's cleanup check runs (stRestore).
async function stHandRemove(ctx) {
  const mp = ctx.mp;
  if (!mp.allowed) return stSkip(mp.skipWhy || 'not run');
  if (!ctx.it.ready) return stModelCleanup(ctx);
  const t = await stYourTurn(ctx, ST_YOUR_TURN.remove); // Stop here: runSelfTest's cleanup check still runs
  mp.cleaned = true;
  let r = null;
  for (let i = 0; i < (t.go ? ST_MODEL.exportTries : 1); i++) {
    if (i) await stDelay(ST_MODEL.exportWaitMs);
    r = await stReread(ctx, false, { force: i > 0 });
    if (!r.ok) return stFail(r.error);
    if (r.text === mp.T0) return stPass(t.go ? `removed by the user; ${stSame(mp.T0)}` : stSame(mp.T0));
  }
  const d = stDiffLines(r.lines, stLines(mp.T0));
  if (!t.go) return stPasteStays(d);
  const left = d.extra.length ? stLineRefs(d.a + 1, d.extra) : 'changes';
  return stWarn(`the document is not empty after your turn (${left}): press Ctrl+Z in Google Docs or delete it by hand`);
}

// The checks in order (one row each): the harmless checks, the "Empty document" gate, then by mode. 'api':
// the write cycle with the reading checks and the Your-turn steps on its two lines, the model scenarios;
// 'export': the write cycle rows (skipped), the paste at the cursor with the reading checks and the Your-turn
// steps on it, the question and the cleanup by the user (Your turn: remove the test text).
// runSelfTest starts with the mode Google suggests and switches when the gate decides otherwise (the rows up
// to the gate are the same in both).
function selfTestChecks(mode = 'api') {
  const head = [
    ['Environment', stEnvironment], ['Content script', stContentScript], ['Change signal', stChangeSignal], ['Selection', stSelection],
    ['Export read', stExport], ['Docs API read', stDocsApi], ['Model list', stModelList], ['Completion', stCompletion],
    ['Empty document', stEmptyDocument],
  ];
  const reading = [['get_outline', stOutline], ['read_lines', stReadLines], ['find_in_document', stFind],
    ['get_selection', stGetSelection], ['read_formatting', stReadFormatting], ['Matching', stMatching]];
  const edits = [['Write: replace_text', stReplace], ['Write: format_text', stFormat], ['Write: text styles', stTextStyles],
    ['Write: format_lines', stFormatLines], ['Write: lists', stLists], ['Write: delete_lines', stDelete], ['Write: undo_last_edit', stUndo]];
  const hands = [['Your turn: select text', stHandSelect], ['Model: replace the selection', stHandReplace],
    ['Your turn: make text bold', stHandBold], ['Your turn: typing signal', stHandTyping]];
  const list = mode === 'api' ? [
    ...head, ['Write: insert_after_line', stInsert], ...reading, ...hands, ...edits,
    ['Model: write a section', stModelWrite], ['Model: replace a phrase', stModelReplace], ['Model: format', stModelFormat],
    ['Model: heading', stModelHeading], ['Model: replace all', stModelReplaceAll], ['Model: list', stModelNumbered],
    ['Model: selection', stModelSelection], ['Model: question', stModelQuestion],
    ['Model: delete', stModelDelete], ['Model: cleanup', stModelCleanupStep], ['Multi-tab', stMultiTab],
  ] : [
    ...head, ['Write: insert_after_line', stInsert], ...edits,
    ['Model: insert at the cursor', stModelWrite], ...reading, ...hands,
    ['Model: question', stModelQuestion], ['Your turn: remove the test text', stHandRemove], ['Multi-tab', stMultiTab],
  ];
  // Rows of feature modules (registerSelfTestRows): after their row, in registration order; at the end otherwise.
  const rows = list.map(([name, run]) => ({ name, run }));
  for (const r of extraSelfTestRows(mode)) {
    let at = rows.findIndex((x) => x.name === r.after);
    if (at < 0) at = rows.length - 1;
    while (at + 1 < rows.length && rows[at + 1].extraAfter === r.after) at++; // keep registration order
    rows.splice(at + 1, 0, { name: r.name, run: r.run, extraAfter: r.after });
  }
  return rows.map(({ name, run }) => ({ name, run }));
}

// ---------------------------------------------------------------------------
// Running and the report
// ---------------------------------------------------------------------------
// /test (sendMessage hands it over before any model request). Nothing goes to the chat history; only the probe
// completion and the model scenarios reach the model. The panel is busy and Stop ends the run (the report lists
// what ran; the panel cleans up after the model scenarios).
async function runSelfTest() {
  if (state.busy) return;
  setBusy(true);
  const abort = new AbortController();
  state.abort = abort;
  el.input.value = '';
  closePopup();
  const started = new Date();
  let mode = state.googleConnected ? 'api' : 'export';
  let checks = selfTestChecks(mode);
  const rows = [];
  const ctx = stContext(abort.signal);
  let left = { leftover: '', modelLeftover: '' };
  const pace = stExportPacer(abort.signal);
  state.exportPace = pace;
  try {
    if (state.loadingCtx) await state.loadingCtx;
    const tab = await getDocTab();
    if (docIdFromUrl(tab.url) !== state.docId) await refreshContext();
    if (state.loadingCtx) await state.loadingCtx;
    stLiveStart(ctx); // after the context load, which may render the chat again
    ctx.tab = tab;
    state.pinnedTabId = tab.id;
    for (let k = 0; k < checks.length && !abort.signal.aborted; k++) {
      const c = checks[k];
      ctx.progress = `Self-test: ${k + 1} of ${checks.length} · ${c.name}`;
      stLive(ctx, ctx.progress);
      const t0 = Date.now();
      let res;
      try { res = await c.run(ctx); } catch (e) {
        res = abort.signal.aborted || e.name === 'AbortError' ? stSkip(ST_STOPPED) : stFail(e.message || String(e));
      }
      rows.push({ name: c.name, ms: Date.now() - t0, ...res });
      if (ctx.mode && ctx.mode !== mode) { mode = ctx.mode; checks = selfTestChecks(mode); } // the gate decided
    }
    left = await stCleanupAfterStop(ctx);
  } catch (e) {
    rows.push({ name: 'Start', ms: 0, ...stFail(e.message || String(e)) });
  } finally {
    state.exportPace = null;
    // The chat's own history (the write cycle saved it first when both ran) and selection.
    if (ctx.phase.saved) state.messages = ctx.phase.saved;
    else if (ctx.mp.saved) state.messages = ctx.mp.saved;
    if (ctx.mp.allowed) { state.selection = ctx.mp.savedSel; renderSelection(); }
  }
  const exportRow = rows.find((r) => r.name === 'Export read');
  if (exportRow) exportRow.detail += ` · ${stPlural(pace.requests, 'export request')} in this self-test`;
  const report = {
    at: started.getTime(), rows, total: checks.length, stopped: abort.signal.aborted, ...left,
    header: selfTestHeader(ctx),
  };
  try {
    const markdown = selfTestMarkdown(report);
    stLiveEnd(ctx);
    selfTestCard(report, markdown);
  } finally {
    stLiveEnd(ctx);
    state.abort = null;
    state.pinnedTabId = null;
    setBusy(false);
    applyPendingSelection();
    setStatus(docStatusText(), state.docText == null); // the document line again (a turn's or an export retry's status may be left)
  }
  return report;
}

// The live row of a running self-test: a notice in the chat with the orb (orbits while the checks run, the wave while
// a Your-turn card waits for the user) and the current row. selfTestCard takes its place at the end; Stop and errors
// end the run the same way, so the orb loop always stops (orbSetState null).
function stLiveStart(ctx) {
  const d = document.createElement('div');
  d.className = 'msg notice selftest-live';
  const orb = orbCreate();
  const text = document.createElement('span');
  text.className = 'st-live-text';
  d.append(orb, text);
  d._orb = orb;
  d._text = text;
  ctx.live = d;
  appendToChat(d);
  stLive(ctx, 'Self-test running…');
}
function stLive(ctx, text, mode = 'orbits') {
  const d = ctx.live;
  if (!d) return;
  d._text.textContent = text;
  orbSetState(d._orb, mode);
}
function stLiveEnd(ctx) {
  const d = ctx.live;
  if (!d) return;
  ctx.live = null;
  orbSetState(d._orb, null);
  d.remove();
}

// The run's shared state (see the phases above: it, phase, mp).
function stContext(signal) {
  return {
    signal, tab: null, info: {}, exp: null, expError: '', fresh: false, apiModel: null, snap: null, progress: '', live: null,
    mode: '', content: null, contentWhy: '',
    it: { ready: false, api: false, line: 0, text: '', shown: false, selected: false, selection: '', selectWhy: '' },
    phase: { allowed: false, failed: false, done: false, journal: [], saved: null },
    mp: { ready: false, allowed: false, api: false, saved: null, savedSel: '', cleaned: false, sec: null, broken: '', stats: { requests: 0, tokensIn: 0, tokensOut: 0, usage: false } },
  };
}

// After a Stop in the write cycle or the model scenarios the panel cleans up what they left: { leftover,
// modelLeftover } (the report's sentences, '' when that phase finished or did not start).
async function stCleanupAfterStop(ctx) {
  const out = { leftover: '', modelLeftover: '' };
  const tell = async (key, run) => {
    try { out[key] = `Stopped: ${(await run()).detail}.`; } catch (e) { out[key] = `Stopped; the cleanup failed: ${e.message}`; }
  };
  if (ctx.phase.allowed && !ctx.phase.done && !ctx.phase.failed) await tell('leftover', () => stRestore(ctx, true, ctx.phase.T0));
  if (ctx.mp.allowed && !ctx.mp.cleaned) await tell('modelLeftover', () => stModelCleanup(ctx));
  return out;
}

// The report's header facts (document text cut to ST_TEXT_CHARS).
function selfTestHeader(ctx) {
  const m = (ctx.snap && ctx.snap.model) || ctx.apiModel;
  const docsTab = m ? `${m.tabId || '(none)'}${m.tabTitle ? ' ' + stQuote(m.tabTitle) : ''}` : (ctx.tab && docsTabFromUrl(ctx.tab.url)) || '(first tab)';
  return {
    version: ctx.info.version || '?', chrome: ctx.info.chrome || '?',
    provider: ctx.info.provider || activeProvider().label, model: ctx.info.model || activeConfig().model || '(none)',
    google: state.googleConnected ? 'connected' : 'not connected',
    title: stClip(state.docTitle || ''), docId: state.docId || '?', docsTab, browserTab: ctx.tab ? ctx.tab.id : '?',
    modelLine: ctx.mp.allowed || ctx.mp.stats.requests ? stModelLine(ctx.mp) : '',
  };
}
// The model part in one line: provider and model, requests, tokens, time.
function stModelLine(mp) {
  const s = mp.stats;
  const tokens = s.usage ? `${fmtNum(s.tokensIn + s.tokensOut)} tokens (${fmtNum(s.tokensIn)} in / ${fmtNum(s.tokensOut)} out)` : 'no token usage reported';
  return `${s.provider} / ${s.model} · ${stPlural(s.requests, 'request')} · ${tokens} · ${stSecs((mp.t1 || mp.t0) - mp.t0)}`;
}

function selfTestSummary(report) {
  const n = (s) => report.rows.filter((r) => r.status === s).length;
  const warn = n('warn');
  let s = `${n('pass')} passed, ${warn} warning${warn === 1 ? '' : 's'}, ${n('fail')} failed, ${n('skip')} skipped`;
  if (report.stopped) s += ` · stopped by the user after ${report.rows.length} of ${report.total} checks`;
  return s;
}
const stDate = (ms) => { const d = new Date(ms); const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
const stCell = (t) => String(t).replace(/\|/g, '\\|').replace(/\n/g, ' ');

// The whole report as Markdown (what Copy report copies).
function selfTestMarkdown(report) {
  const h = report.header;
  const out = [
    '## Munin self-test', '',
    `- Date: ${stDate(report.at)}`,
    `- Version: ${h.version} · Chrome ${h.chrome}`,
    `- Provider: ${h.provider} / ${h.model}`,
    `- Google: ${h.google}`,
    `- Document: «${h.title}» (${h.docId}) · Docs tab ${h.docsTab} · browser tab ${h.browserTab}`,
    ...(h.modelLine ? [`- Model: ${h.modelLine}`] : []), '',
    '| # | Check | Result | Time | Detail |', '|---|---|---|---|---|',
    ...report.rows.map((r, i) => `| ${i + 1} | ${stCell(r.name)} | ${ST_ICONS[r.status]} ${ST_LABELS[r.status]} | ${fmtNum(r.ms)} ms | ${stCell(r.detail)} |`),
    '', `**Summary:** ${selfTestSummary(report)}`,
  ];
  if (report.leftover) out.push('', `**Write cycle:** ${report.leftover}`);
  if (report.modelLeftover) out.push('', `**Model scenarios:** ${report.modelLeftover}`);
  const more = report.rows.map((r, i) => (r.more ? `**${i + 1}. ${r.name}:** ${r.more.replace(/\n/g, ' ')}` : null)).filter(Boolean);
  if (more.length) out.push('', '### Details', '', ...more.flatMap((m) => [m, '']));
  return out.join('\n').replace(/\n+$/, '') + '\n';
}

// The report card in the chat: a notice-like element (renderHistory drops it), never stored in the history.
function selfTestCard(report, markdown = selfTestMarkdown(report)) {
  const h = report.header;
  const failed = report.rows.some((r) => r.status === 'fail');
  const row = (r) => {
    const line = `<span class="st-icon">${ST_ICONS[r.status]}</span> <span class="st-name">${escapeHtml(r.name)}</span> ` +
      `<span class="st-ms">${escapeHtml(fmtNum(r.ms))} ms</span> <span class="st-detail">${escapeHtml(r.detail)}</span>`;
    return r.more
      ? `<details class="st-row st-${r.status}"><summary>${line}</summary><pre>${escapeHtml(r.more)}</pre></details>`
      : `<div class="st-row st-${r.status}">${line}</div>`;
  };
  const d = document.createElement('div');
  d.className = 'msg notice selftest';
  d.innerHTML = `<div class="st-head">🩺 Self-test · ${escapeHtml(stDate(report.at))} · v${escapeHtml(h.version)} · ` +
    `${escapeHtml(h.provider)} / ${escapeHtml(h.model)} · Google ${escapeHtml(h.google)}</div>` +
    `<div class="st-sub">«${escapeHtml(h.title)}» (${escapeHtml(h.docId)}) · Docs tab ${escapeHtml(h.docsTab)} · browser tab ${escapeHtml(h.browserTab)}</div>` +
    (h.modelLine ? `<div class="st-sub st-model">Model: ${escapeHtml(h.modelLine)}</div>` : '') +
    `<div class="st-rows">${report.rows.map(row).join('')}</div>` +
    `<div class="st-summary">${escapeHtml(selfTestSummary(report))}</div>` +
    (report.leftover ? `<div class="st-leftover">${escapeHtml(report.leftover)}</div>` : '') +
    (report.modelLeftover ? `<div class="st-leftover">${escapeHtml(report.modelLeftover)}</div>` : '') +
    '<div class="tool-actions st-actions"><button class="btn small" type="button" data-act="copy-selftest" title="Copy the whole report as Markdown">Copy report</button>' +
    (failed ? '<span class="st-hint">Send this report to the developer</span>' : '') + '</div>';
  d._report = markdown;
  d._selfTest = report;
  return appendToChat(d);
}
