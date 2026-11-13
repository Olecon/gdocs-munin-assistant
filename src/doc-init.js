'use strict';
// Module doc-init.js: document instructions written from the document, like a project note (Claude Code's CLAUDE.md).
// The first message in a document (instructions empty, at least DOC_INIT_MIN_CHARS of text, no message in any of its
// chats, not a slash command) also starts one quiet document pass (the pass kind "card" of request.js: the whole
// numbered text or its outline plus the reading tools, the task DOC_INIT_TASK of prompts.js plus the user's first
// request, no chat history). The answer (parseDocInit) is added to the document instructions. The pass runs in the
// background, beside the turn: it starts from the turn's document read and the turn never waits for it, so the first
// answer goes out without the new instructions and they apply from the next message. Stop stops it (with the turn,
// or alone from its row: an action row under the first turn, see showDocInitRow). One attempt per document (docInitKey).
/* global activityRow, appendToChat, buildTurnContext, detectFormattingLine, docInitKey, DOC_INSTRUCTIONS_MAX, el, fetchNamedStyles,
   hasFormattingLine, onChatRedraw, openFiles, orbCreate, orbSetState, readDocInstructions, registerTurnHook, saveInstructions, state,
   takeSnapshot, toolLoop, writeDocInstructions */
/* exported DOC_INIT_MIN_CHARS, parseDocInit, mergeDocInit, shouldDocInit, runDocInit, startDocInit, docInitRunning, docInitFormatting */

const DOC_INIT_MIN_CHARS = 300;
const DOC_INIT_MAX_LINES = 10;

// ---- Parsing ------------------------------------------------------------------------------------------------
// The model's note as lines: code fences, bullets, numbering, headings and bold marks stripped, empty lines and a
// leading "Here is…" line dropped, at most DOC_INIT_MAX_LINES lines.
function parseDocInit(raw) {
  const text = String(raw == null ? '' : raw).replace(/<think>[\s\S]*?<\/think>/g, '');
  const lines = text.split('\n')
    .filter((l) => !/^\s*(```|~~~)/.test(l))
    .map((l) => l.replace(/^\s*(?:#{1,6}\s+|>\s*)?(?:[-*•–—+]\s+|\d{1,2}[.)]\s+)?/, '').replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (lines.length && /^(sure|here|below|okay|ok|project note|document instructions|doc\.md)\b.*:$/i.test(lines[0])) lines.shift();
  return lines.slice(0, DOC_INIT_MAX_LINES);
}
// The instructions with the note's lines added: after a blank line when there is text already (the user's lines are
// never changed); whole lines only, within DOC_INSTRUCTIONS_MAX. Returns { text, added }.
function mergeDocInit(existing, lines) {
  const base = String(existing || '').trim();
  let text = base;
  let added = 0;
  for (const line of lines) {
    const next = text ? `${text}${added || !base ? '\n' : '\n\n'}${line}` : line;
    if (next.length > DOC_INSTRUCTIONS_MAX) break;
    text = next;
    added++;
  }
  return { text, added };
}

// ---- When it runs -------------------------------------------------------------------------------------------
// Whether this document already had a turn: a user message in the open chat, or any chat with a title (a chat gets
// its title with its first user message).
const docHadTurn = () => state.messages.some((m) => m.role === 'user') || state.chats.some((c) => c && c.title);
async function docInitTried(docId) {
  try { return !!(await chrome.storage.local.get(docInitKey(docId)))[docInitKey(docId)]; } catch (e) { return true; }
}
// The attempt, with its outcome for the pass's row (view: { chatId, status, added, lines, reason }).
async function markDocInit(docId, view = {}) {
  try { await chrome.storage.local.set({ [docInitKey(docId)]: { at: Date.now(), ...view } }); } catch (e) { /* the next message tries again */ }
}
// The trigger, before the turn reads the document again (the pass checks the length of that read once more).
async function shouldDocInit({ text, persona }) {
  const docId = state.docId;
  if (!docId || persona || /^\s*\//.test(String(text || ''))) return false;
  if (String(state.docInstructions || '').trim() || docHadTurn()) return false;
  if (state.docText != null && state.docText.trim().length < DOC_INIT_MIN_CHARS) return false;
  return !(await docInitTried(docId));
}

// ---- The pass's row -------------------------------------------------------------------------------------------
// One action row under the first turn, drawn by render.js activityRow like a tool call's: while the pass runs a pending
// row "DOC.md: Reading the document …" with the orb in the rail's gutter and Stop at its right end (Stop stops the pass
// alone: the panel's button is Send once the turn is over); once done a write row "DOC.md · Done · 7 lines written; they
// apply from your next message" whose fold shows the written lines and Open DOC.md (the Files panel); stopped or failed
// one short row. The row is the outcome stored under docInitKey (the attempt flag): every redraw of the chat
// (render.js onChatRedraw) and a reload of the panel put it back under the first turn of the chat the pass started in.
const DOC_INIT_NAME = 'DOC.md';
const DOC_INIT_READING = 'Reading the document';
const docInitRows = new Map(); // docId -> { chatId, el }: the row of each document's pass in this panel
// The row's element for a view: { status: 'running' | 'done' | 'stopped' | 'failed', added, lines, reason }; stop:
// the running row's Stop.
function docInitRowEl(view, stop) {
  const d = document.createElement('div');
  d.className = 'msg doc-init-row';
  d._docInit = view;
  const entry = { log: true, id: 'doc-init', name: DOC_INIT_NAME, args: null };
  let row;
  if (view.status === 'running') {
    row = activityRow({ ...entry, summary: DOC_INIT_READING, result: null, status: 'pending' });
    const orb = orbCreate();
    d._orb = orb;
    d.append(orb, row);
    if (stop) {
      const acts = document.createElement('span');
      acts.className = 'row-acts';
      const btn = document.createElement('button');
      btn.className = 'row-act doc-init-stop';
      btn.type = 'button';
      btn.textContent = 'Stop';
      btn.dataset.tip = 'Stop writing DOC.md';
      btn.setAttribute('aria-label', 'Stop writing DOC.md');
      btn.addEventListener('click', () => { btn.disabled = true; stop(); });
      acts.append(btn);
      d.append(acts);
      d._stop = btn;
    }
  } else if (view.status === 'done') {
    const n = Number(view.added) || 0;
    const lines = Array.isArray(view.lines) ? view.lines.map(String) : [];
    row = activityRow({ ...entry, summary: '', result: '', status: 'ok', write: {
      message: `Added to DOC.md: ${n} line${n === 1 ? '' : 's'}`, detail: 'They apply from your next message.',
      text: lines.join('\n'), label: 'Written lines', preview: `${n} line${n === 1 ? '' : 's'} written; they apply from your next message`, noLog: true } });
    d.append(row);
    const body = row.querySelector && row.querySelector('.log-body');
    if (body) {
      const btn = document.createElement('button');
      btn.className = 'btn small doc-init-open';
      btn.type = 'button';
      btn.textContent = 'Open DOC.md';
      btn.dataset.tip = 'Edit DOC.md in Files';
      btn.addEventListener('click', () => openFiles('document'));
      body.append(btn);
    }
  } else if (view.status === 'failed') {
    const reason = String(view.reason || 'unknown error');
    row = activityRow({ ...entry, summary: `not written: ${reason}`, result: `Could not write DOC.md: ${reason}. The chat goes on.`, status: 'fail' });
    d.append(row);
  } else {
    row = activityRow({ log: false, name: DOC_INIT_NAME, summary: 'Stopped; nothing written' });
    d.append(row);
  }
  d._row = row;
  return d;
}
// Puts the row of the panel's document under the first turn of its chat: before the chat's second user message, else
// at the end; nowhere in another chat or in a chat without a user message.
function placeDocInitRow() {
  const v = docInitRows.get(state.docId);
  for (const w of docInitRows.values()) if (w !== v && w.el.isConnected) w.el.remove();
  if (!v) return;
  const kids = [...el.chat.children];
  const users = kids.filter((c) => c !== v.el && c.classList && c.classList.contains('msg') && c.classList.contains('user'));
  if (v.chatId !== state.chatId || !users.length) { if (v.el.isConnected) v.el.remove(); return; }
  const next = users[1] || null;
  const at = kids.indexOf(v.el);
  if (at >= 0 && (next ? kids[at + 1] === next : at === kids.length - 1)) return;
  const others = kids.filter((c) => c !== v.el);
  const before = next ? others[others.indexOf(next) - 1] : null;
  if (before) before.after(v.el); else appendToChat(v.el, false);
  // orb.js ends an orb's loop once it leaves the page (a redraw cleared the chat): a running row's orb starts again.
  if (v.el._orb && v.el._docInit.status === 'running') { orbSetState(v.el._orb, null); orbSetState(v.el._orb, 'orbits'); }
}
// Shows view as the row of docId's pass in chatId (a running row's orb stops when it is replaced).
function showDocInitRow(docId, chatId, view, stop) {
  const old = docInitRows.get(docId);
  const d = docInitRowEl(view, stop);
  if (old && old.el._orb) orbSetState(old.el._orb, null);
  if (old && old.el.isConnected) old.el.replaceWith(d);
  docInitRows.set(docId, { chatId, el: d });
  if (state.docId === docId) placeDocInitRow();
  return d;
}
// The stored outcome of an earlier pass (a flag of an earlier build is a number: no row).
async function loadDocInitRow(docId) {
  if (!docId || docInitRows.has(docId)) { placeDocInitRow(); return; }
  let v = null;
  try { v = (await chrome.storage.local.get(docInitKey(docId)))[docInitKey(docId)]; } catch (e) { v = null; }
  if (v && typeof v === 'object' && v.chatId && ['done', 'stopped', 'failed'].includes(v.status) && !docInitRows.has(docId)) {
    docInitRows.set(docId, { chatId: v.chatId, el: docInitRowEl(v) });
  }
  if (state.docId === docId) placeDocInitRow();
}
onChatRedraw(placeDocInitRow);
registerTurnHook('panelDoc', (docId) => loadDocInitRow(docId));

// ---- The pass -----------------------------------------------------------------------------------------------
// The pass's own snapshot: the provider and the document as the turn that started it read them (no second read of the
// document, nothing on the status line), its own signal, no chat. background: runStream keeps its retry text off the
// status line, which belongs to the turn.
function docInitSnapshot(from, docId, signal) {
  const pass = takeSnapshot();
  Object.assign(pass, {
    prov: from.prov, cfg: { ...from.cfg }, signal, background: true,
    docText: from.docText, docFormat: from.docFormat, docTitle: from.docTitle, docError: from.docError, selection: from.selection,
    model: from.model, promptView: from.promptView, docInstructions: from.docInstructions, mainInstructions: from.mainInstructions,
    docId, docs: (from.docs || []).map((d) => ({ ...d })), docCache: new Map(), googleConnected: from.googleConnected,
    mainUrl: from.mainUrl, chatCtx: { docId, chatId: null, messages: [] },
  });
  return pass;
}
const docInitStopped = () => Object.assign(new Error('Stopped'), { name: 'AbortError' });
// The Formatting: line of the fonts and sizes the document already uses (style-sheet.js detectFormattingLine), measured by
// code on the turn's Docs API read and the document's named styles (one small read); '' with the export, with too
// little text, for a document that follows the sheet in force, or when the named styles cannot be read.
async function docInitFormatting(pass) {
  if (pass.docFormat !== 'docs-api' || !pass.model || !pass.model.docId) return '';
  try {
    const named = await fetchNamedStyles(pass.model.docId, pass.model.tabId);
    return detectFormattingLine(pass.model, named, pass.mainInstructions);
  } catch (e) {
    return '';
  }
}
// One quiet request on the document alone; request: the user's first request; from: the turn's snapshot (its document
// read). The note's lines are added to the document's instructions as stored now, after a blank line when there is
// text already (a remember of the turn meanwhile, the user's own lines), and only while the panel still shows that
// document. Returns { added, lines: the lines written } or { skipped } (the document is too short for the first run); throws on an error or
// Stop (AbortError).
async function docInitPass({ docId, request, signal, first, from }) {
  const pass = docInitSnapshot(from, docId, signal);
  if (pass.docText == null) throw new Error(pass.docError || 'the document text is unavailable');
  if (first && pass.docText.trim().length < DOC_INIT_MIN_CHARS) return { skipped: true };
  const content = request ? `The user's first request: ${request}` : 'There is no request from the user yet.';
  const history = [{ role: 'user', content, _context: buildTurnContext('card', pass, null) }];
  const formatting = docInitFormatting(pass); // no model request: beside the pass's own
  await toolLoop('card', pass, signal, { messages: history, quiet: true, request: { history }, status: () => {} });
  if (signal.aborted) throw docInitStopped();
  const last = [...history].reverse().find((m) => m.role === 'assistant' && m.content);
  const lines = parseDocInit(last ? last.content : '').filter((l) => !hasFormattingLine(l)); // only the measured line
  const fmt = await formatting;
  if (!lines.length && !fmt) throw new Error('the answer was empty');
  if (state.docId !== docId) throw new Error('the document changed');
  // A typing pause in the open section is saved first, so the user's latest text is kept.
  await saveInstructions();
  if (signal.aborted) throw docInitStopped();
  const stored = await readDocInstructions(docId);
  const note = [...lines, ...(fmt && !hasFormattingLine(stored) ? [fmt] : [])];
  const { text, added } = mergeDocInit(stored, note);
  if (!added) throw new Error('DOC.md is full');
  await writeDocInstructions(docId, text);
  return { added, lines: note.slice(0, added) };
}
// Runs the pass with its row (showDocInitRow). stop(): the row's Stop; chatId: the chat whose first turn started it.
// Returns 'done', 'skipped', 'failed' or 'stopped'.
async function runDocInit({ request = '', signal, first = false, from, docId, chatId = null, stop = null }) {
  const chat = chatId || state.chatId;
  showDocInitRow(docId, chat, { status: 'running' }, stop);
  let view = { status: 'failed', reason: 'unknown error' };
  try {
    const r = await docInitPass({ docId, request, signal, first, from });
    if (r.skipped) view = { status: 'skipped' };
    else view = { status: 'done', added: r.added, lines: r.lines };
  } catch (e) {
    if (signal.aborted || e.name === 'AbortError') view = { status: 'stopped' };
    else view = { status: 'failed', reason: String((e && e.message) || e).replace(/\.$/, '') };
  } finally {
    if (view.status === 'skipped') { // nothing to show: the document is too short for the first run
      const v = docInitRows.get(docId);
      if (v && v.el._orb) orbSetState(v.el._orb, null);
      if (v) v.el.remove();
      docInitRows.delete(docId);
    } else {
      showDocInitRow(docId, chat, view);
      await markDocInit(docId, { chatId: chat, ...view }); // one attempt per document, whatever came of it
    }
  }
  return view.status;
}

// ---- In the background ----------------------------------------------------------------------------------------
// The pass runs beside the chat: started from the turn that triggered it and never awaited by it; it sets neither
// state.busy nor state.abort and leaves the status line alone. A Stop of any turn while it runs stops it too.
let docInitPending = null; // { signal, request, docId }: the turn that triggers the pass, until its snapshot is taken
let docInitRun = null; // { abort, docId, done }: the pass in flight
// The pass in flight ({ abort, docId, done: the promise of its outcome }) or null.
const docInitRunning = () => docInitRun;
function startDocInit({ request, from, turnSignal, first = true }) {
  const docId = from.docId;
  const abort = new AbortController();
  const stop = () => abort.abort();
  if (turnSignal) turnSignal.addEventListener('abort', stop, { once: true });
  const run = { abort, docId, later: [] }; // later: the [signal, listener] of the later turns that stop it too
  docInitRun = run;
  const chatId = (from.chatCtx && from.chatCtx.chatId) || state.chatId;
  run.done = runDocInit({ request, signal: abort.signal, first, from, docId, chatId, stop })
    .finally(() => {
      if (turnSignal) turnSignal.removeEventListener('abort', stop);
      for (const [sig, fn] of run.later) sig.removeEventListener('abort', fn);
      run.later.length = 0;
      if (docInitRun === run) docInitRun = null;
    });
  return run;
}

// The trigger is decided before the turn reads the document (beforeStart: the history is still as it was); the pass
// starts once the turn has its snapshot (beforeTurn), from the same document read, and the turn goes on at once.
registerTurnHook('beforeStart', async ({ text, persona, signal }) => {
  docInitPending = null;
  const run = docInitRun;
  if (run) { // a later message while the pass runs: its Stop stops the pass too (removed when the pass ends)
    if (signal) {
      const fn = () => run.abort.abort();
      signal.addEventListener('abort', fn, { once: true });
      if (run.later) run.later.push([signal, fn]);
    }
    return;
  }
  if (!(await shouldDocInit({ text, persona }))) return;
  docInitPending = { signal, request: String(text || '').trim(), docId: state.docId };
});
registerTurnHook('beforeTurn', (mode, snap) => {
  const p = docInitPending;
  if (!p || !snap || snap.side || snap.signal !== p.signal) return '';
  docInitPending = null;
  if (docInitRun || snap.docId !== p.docId || (p.signal && p.signal.aborted)) return '';
  startDocInit({ request: p.request, from: snap, turnSignal: p.signal, first: true });
  return '';
});
