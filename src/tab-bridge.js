'use strict';
// Module tab-bridge.js: communication with the Docs tab (getDocTab, sendToTab), the document export
// (fetchDocText, readExport: the panel's fetchDocTextFromPanel, then the content script's fetchDocTextFromTab), the selection (refreshSelection, onRuntimeMessage) and pasting into the
// document (applyToDocument, applyToDocumentNow), and scrolling the editor to a line (scrollToLine).
/* global addError, addNotice, DOC_URL_RE, docsTabFromUrl, docStatusText, el, EXPORT_RATE_LIMITED, EXPORT_RETRY_AFTER_MAX_MS,
   EXPORT_RETRY_DELAYS_MS, fetchDocModel, fmtNum, HOST_TAB_ID, markDocRead, onDocChanged, onDocTyped, PASTE_UNCONFIRMED, SELECTION_CHANGED_NOTICE, setStatus, showYourTurnSelection, state, useDocModel */
/* exported getDocTab, docIdFromUrl, sendToTab, cleanDocText, fetchDocTextFromPanel, fetchDocText, readExport, setDocTitle,
   exportAbortError, exportSleep, useExportRead,
   renderSelection, refreshSelection, onRuntimeMessage, setDocSignalTap, applyPendingSelection, applyToDocument, scrollToLine,
   SCROLL_NOT_FOUND */

// ---------------------------------------------------------------------------
// Communication with the document tab
// ---------------------------------------------------------------------------
// The document tab this panel belongs to: the host tab from "#tabId=N" (overlay mode),
// or, as a fallback when the hash is missing, the active tab of the current window.
async function getDocTab() {
  let tab;
  if (HOST_TAB_ID != null) {
    try { tab = await chrome.tabs.get(HOST_TAB_ID); } catch (e) { throw new Error('The document tab was closed'); }
    if (!DOC_URL_RE.test(tab.url || '')) throw new Error('The host tab is no longer a Google Docs document');
    return tab;
  }
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab found');
  if (!DOC_URL_RE.test(tab.url || '')) throw new Error('The active tab is not a Google Docs document');
  return tab;
}

function docIdFromUrl(url) {
  const m = String(url || '').match(/\/document\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// Tab to talk to: the pinned one while a request is running, otherwise the document tab.
async function getTargetTab() {
  if (state.pinnedTabId == null) return getDocTab();
  let tab;
  try { tab = await chrome.tabs.get(state.pinnedTabId); } catch (e) { throw new Error('The document tab was closed'); }
  if (!DOC_URL_RE.test(tab.url || '') || docIdFromUrl(tab.url) !== state.docId) {
    throw new Error('A different document is now open in that tab');
  }
  return tab;
}

async function sendToTab(msg) {
  const tab = await getTargetTab();
  const trySend = () => chrome.tabs.sendMessage(tab.id, msg);
  let resp;
  try {
    resp = await trySend();
  } catch (e) {
    const text = String(e && e.message);
    if (!/Receiving end does not exist|Could not establish connection/i.test(text)) throw e;
    // The page was opened before the extension was installed/reloaded: inject the script.
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    } catch (e2) {
      throw new Error('Content script is unavailable. Reload the document tab (F5).');
    }
    resp = await trySend();
  }
  if (resp === undefined) throw new Error('No response from the document tab. Reload it (F5).');
  return resp;
}

// Google Docs' Markdown export escapes every character that could be read as Markdown syntax
// ("3\\.", "\\-", "\\[link\\]", "x\\_y"). The model would read and sometimes copy those backslashes, and
// find_in_document would miss "3.". Escapes of plain punctuation are removed; the ones that carry
// structure in Markdown (\\#, \\`, \\\\) are kept so the outline and code fences stay correct.
const unescapeDocsMarkdown = (text) => String(text).replace(/\\([.\-+()[\]!<>|~*_])/g, '$1');
const cleanDocText = (text, format) => (format === 'markdown' ? unescapeDocsMarkdown(text) : text);

// ---------------------------------------------------------------------------
// The document export (without the Docs API)
// ---------------------------------------------------------------------------
// Two routes deliver …/export?format=md (Markdown; format=txt as a fallback): the panel's own fetch
// ('panel', primary: the extension page has host permissions for docs.google.com and the
// *.googleusercontent.com download host the export may redirect to) and the content script's GET_DOC_TEXT
// in the Docs tab ('tab', the fallback: a same-origin request with the tab's session, useful where the panel's
// request has no cookies for that account; a cross-origin redirect makes it fail with "Failed to fetch").
// A route that failed with a network error is skipped for the rest of the panel's session in that tab
// (exportDeadRoutes, reset on reload) unless every route is marked. HTTP 429 is waited out and retried
// (EXPORT_RETRY_DELAYS_MS, Retry-After) and never sent on to the other route or to format=txt.
const EXPORT_ROUTES = ['panel', 'tab'];
const exportDeadRoutes = new Map(); // tab ID -> Map(route -> the network error)

const exportAbortError = () => { const e = new Error('Stopped'); e.name = 'AbortError'; return e; };

// Waits ms; a Stop (signal) rejects with an AbortError at once. Every export wait goes through it.
function exportSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(exportAbortError()); return; }
    const onAbort = () => { clearTimeout(t); reject(exportAbortError()); };
    const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

// Retry-After (seconds or an HTTP date) in ms, or null when absent or unreadable.
function exportRetryAfterMs(value) {
  const v = String(value == null ? '' : value).trim();
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

// Runs attempt() (one export request; an HTTP error carries .status and .retryAfter) and retries it after
// HTTP 429: once per EXPORT_RETRY_DELAYS_MS entry, or after Retry-After. Still rate-limited (or asked to wait
// longer than EXPORT_RETRY_AFTER_MAX_MS): an Error with .rateLimited and the EXPORT_RATE_LIMITED message.
async function exportWithRetry(attempt, signal) {
  for (let i = 0; ; i++) {
    try { return await attempt(); } catch (e) {
      if (e.status !== 429) throw e;
      const after = exportRetryAfterMs(e.retryAfter);
      if (i >= EXPORT_RETRY_DELAYS_MS.length || (after != null && after > EXPORT_RETRY_AFTER_MAX_MS)) {
        const err = new Error(EXPORT_RATE_LIMITED);
        err.rateLimited = true;
        if (after != null) err.retryAfterMs = after; // the live document line waits that long (src/doc-live.js)
        err.status = 429;
        throw err;
      }
      const ms = after != null ? after : EXPORT_RETRY_DELAYS_MS[i];
      setStatus(`The Google export is busy (HTTP 429); retrying in ${Math.max(1, Math.round(ms / 1000))} s…`);
      await exportSleep(ms, signal);
    }
  }
}

// The self-test's request counter (state.exportPace.onRequest), when one is installed.
const countExportRequests = (n) => { if (state.exportPace && n > 0) state.exportPace.onRequest(n); };

// The panel's own export (host_permissions include docs.google.com): Markdown first (structure for the
// outline), plain text if that export is unavailable; not after a network error, a rate limit or Stop, which
// would hit format=txt as well. An empty Markdown body (HTTP 200) is an empty document. authuser: the Google
// account index to export with (default: the "/u/N/" part of url). signal: Stop. Returns { text, format,
// title } (title from the download file name, '' when the response does not carry one). Errors carry
// .network (the request itself failed) or .status / .rateLimited.
async function fetchDocTextFromPanel(docId, url, authuser, signal) {
  const au = authuser != null ? authuser : (String(url || '').match(/\/document\/u\/(\d+)\//) || [])[1];
  const get = async (format) => {
    countExportRequests(1);
    let resp;
    try {
      resp = await fetch(`https://docs.google.com/document/d/${docId}/export?format=${format}${au ? `&authuser=${au}` : ''}`,
        signal ? { credentials: 'include', signal } : { credentials: 'include' });
    } catch (e) {
      if ((signal && signal.aborted) || (e && e.name === 'AbortError')) throw exportAbortError();
      const err = new Error((e && e.message) || String(e));
      err.network = true;
      throw err;
    }
    if (!resp.ok) {
      const err = new Error(`HTTP ${resp.status}`);
      err.status = resp.status;
      try { err.retryAfter = (resp.headers && typeof resp.headers.get === 'function' && resp.headers.get('retry-after')) || ''; } catch (e) { /* no headers */ }
      throw err;
    }
    let text = await resp.text();
    if (/^\s*<!doctype html|^\s*<html/i.test(text.slice(0, 200))) throw new Error('export returned HTML (no access)');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return { text: text.replace(/\r\n/g, '\n'), title: exportTitle(resp) };
  };
  try { return { ...(await exportWithRetry(() => get('md'), signal)), format: 'markdown' }; } catch (e) {
    if (e.network || e.rateLimited || e.name === 'AbortError') throw e;
    /* no Markdown export */
  }
  return { ...(await exportWithRetry(() => get('txt'), signal)), format: 'text' };
}

// Document title from an export response's Content-Disposition file name ("Title.md"), or ''.
function exportTitle(resp) {
  let cd = '';
  try { cd = (resp.headers && typeof resp.headers.get === 'function' && resp.headers.get('content-disposition')) || ''; } catch (e) { return ''; }
  let name = '';
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(cd);
  if (star) { try { name = decodeURIComponent(star[1].trim()); } catch (e) { name = star[1].trim(); } }
  else { const plain = /filename\s*=\s*"([^"]*)"/.exec(cd) || /filename\s*=\s*([^;]+)/.exec(cd); if (plain) name = plain[1].trim(); }
  return name.replace(/\.(md|txt)$/i, '');
}

// The content script's export (GET_DOC_TEXT), with the same 429 retries. Returns { text, format, title }.
async function fetchDocTextFromTab(signal) {
  return exportWithRetry(async () => {
    const r = await sendToTab({ type: 'GET_DOC_TEXT' });
    countExportRequests(r && r.requests != null ? r.requests : 1);
    if (r && r.ok) return { text: String(r.text == null ? '' : r.text), format: r.format === 'markdown' ? 'markdown' : 'text', title: r.title || '' };
    const err = new Error((r && r.error) || 'unknown error');
    err.title = (r && r.title) || '';
    if (r && (r.network || /^(Failed to fetch|NetworkError|Load failed)/i.test(err.message))) err.network = true;
    if (r && r.status) err.status = r.status;
    if (r && r.retryAfter) err.retryAfter = r.retryAfter;
    return Promise.reject(err);
  }, signal);
}

// Puts an export read (readExport's result) into the panel state, as fetchDocText does.
function useExportRead(r) {
  state.docModel = null;
  state.docText = r.text; state.docFormat = r.format; state.docError = '';
  markDocRead();
}

// Reads the document: through the Docs API when a Google account is connected (line model with API
// indices, see buildLineModel), otherwise, or when the API fails (one notice), via the export. A Stop of the
// running request (state.abort) ends an export wait.
async function fetchDocText() {
  let tab;
  try { tab = await getTargetTab(); } catch (e) {
    state.docText = null; state.docModel = null; state.docError = e.message; setStatus(e.message, true);
    return;
  }
  if (state.googleConnected) {
    try {
      const id = docIdFromUrl(tab.url);
      if (!id) throw new Error('no document ID in the tab URL.');
      const model = await fetchDocModel(id, docsTabFromUrl(tab.url), false);
      useDocModel(model);
      if (model.title) setDocTitle(model.title);
      state.apiWarned = false;
      setStatus(docStatusText());
      return;
    } catch (e) {
      state.docsApiFailed = true; // not called again in this turn (see resetDocsApiTurn)
      if (!state.apiWarned) {
        state.apiWarned = true;
        addNotice(`Could not read the document through the Google Docs API: ${e.message} Using the export instead; ` +
          'the precise editing tools are unavailable until the API works again.', { sticky: true });
      }
    }
  }
  state.docModel = null;
  try {
    const r = await readExport(tab, setDocTitle, { signal: state.abort ? state.abort.signal : null });
    useExportRead(r);
    setStatus(docStatusText());
  } catch (e) {
    state.docText = null;
    state.docError = e.message;
    setStatus('Document text unavailable, working without it', true);
  }
}

// The export path of fetchDocText: the panel's own export (fetchDocTextFromPanel), then the content script's
// GET_DOC_TEXT (fetchDocTextFromTab), one after the other, never both at once; a route that failed with a
// network error earlier in this tab is skipped (see EXPORT_ROUTES). onTitle receives a title a route reports
// (the content script reports one also when its export failed). opts.signal: Stop. Returns { text (cleaned),
// format: 'markdown' | 'text', via: 'panel' | 'tab' (the route that delivered it), panelError / tabError (why
// that route failed or was skipped, when it was) }; throws an Error whose message is the panel's docError text
// (a rate limit: EXPORT_RATE_LIMITED; the other route is not tried then). Any text counts, an empty one (an
// empty document) included. The self-test (/test) reads the export through it too (state.exportPace: its
// spacing between reads and its request counter).
async function readExport(tab, onTitle = () => {}, { signal = null } = {}) {
  if (state.exportPace) await state.exportPace.beforeRead(signal);
  if (!exportDeadRoutes.has(tab.id)) exportDeadRoutes.set(tab.id, new Map());
  const dead = exportDeadRoutes.get(tab.id);
  const live = EXPORT_ROUTES.filter((r) => !dead.has(r));
  const order = live.length ? live : EXPORT_ROUTES;
  const errors = {};
  for (const r of EXPORT_ROUTES) if (!order.includes(r)) errors[r] = `skipped: it failed earlier with a network error (${dead.get(r)})`;
  const tried = [];
  for (const route of order) {
    try {
      let got;
      if (route === 'panel') {
        const id = docIdFromUrl(tab.url);
        if (!id) throw new Error('no document ID');
        got = await fetchDocTextFromPanel(id, tab.url, null, signal);
      } else {
        got = await fetchDocTextFromTab(signal);
      }
      dead.delete(route);
      if (got.title) onTitle(got.title);
      const out = { text: cleanDocText(got.text, got.format), format: got.format, via: route };
      if (errors.panel) out.panelError = errors.panel;
      if (errors.tab) out.tabError = errors.tab;
      return out;
    } catch (e) {
      if (e.name === 'AbortError' || (signal && signal.aborted)) throw exportAbortError();
      if (e.title) onTitle(e.title);
      if (e.rateLimited) {
        const err = new Error(`Could not get the document text: ${EXPORT_RATE_LIMITED}.`);
        err.rateLimited = true; // the live document line backs off on it (src/doc-live.js)
        if (e.retryAfterMs != null) err.retryAfterMs = e.retryAfterMs;
        throw err;
      }
      if (e.network) dead.set(route, e.message);
      errors[route] = e.message;
      tried.push(e.message);
    }
  }
  throw new Error(`Could not get the document text (${tried.join('; ')}).`);
}

function setDocTitle(t) {
  state.docTitle = t || 'Document';
  el.docTitle.textContent = state.docTitle;
  el.docTitle.title = state.docTitle;
}

function renderSelection() {
  const s = state.selection;
  if (!s) {
    el.selPreview.textContent = '(nothing selected)';
    el.selFull.textContent = '';
  } else {
    const oneLine = s.replace(/\s+/g, ' ');
    el.selPreview.textContent = (oneLine.length > 80 ? oneLine.slice(0, 80) + '…' : oneLine) + ` (${fmtNum(s.length)} chars)`;
    el.selFull.textContent = s;
  }
}

// Reads the selection from the document. If it cannot be read, the chat simply works
// without a selection. Returns what was read: { text, cached (the content script answered from its cache),
// error? (the tab could not be asked) }; the self-test's "Your turn: select text" reports it.
async function refreshSelection({ quiet = true } = {}) {
  const out = { text: '', cached: false };
  try {
    const r = await sendToTab({ type: 'GET_SELECTION' });
    const text = (r && r.ok && r.text) || '';
    state.selection = text;
    out.text = text;
    out.cached = !!(r && r.cached);
    if (!text && !quiet) addNotice('No selection found in the document. Select text in the document and send the message again.');
  } catch (e) {
    out.error = e.message;
    if (!quiet) addError(e.message);
  }
  renderSelection();
  return out;
}

// SELECTION_UPDATE from the host tab's content script (sent when the user finishes selecting in
// the document). Only used when embedded (the tab ID comes from the hash). While a request is
// running, the latest update is kept and applied when it finishes (a turn works on its snapshot).
// While the self-test's Your-turn card waits (the panel is busy, but the user is the one acting), the update
// is shown at once: the Selected line and the card's "The panel sees" line (showYourTurnSelection). Setting
// state.selection then is safe: no turn is running to read it, the self-test's scenarios set their own
// selection (stScenario) and the select step reads the selection afresh after Continue (refreshSelection).
// pendingSelection is still kept, so the end of the run (applyPendingSelection) leaves the latest selection
// as before, whatever the self-test restored.
// DOC_CHANGED (a change in the document: the content script's page observer or its key and input events, at most one
// per second per source) and DOC_TYPED (the typing deltas, coalesced) go to the live document line (src/doc-live.js),
// and to the self-test's tap while one is set (setDocSignalTap: its "Your turn: typing signal" row counts them).
let docSignalTap = null;
function setDocSignalTap(fn) { docSignalTap = typeof fn === 'function' ? fn : null; }
function onRuntimeMessage(msg) {
  if (!msg || (msg.type !== 'SELECTION_UPDATE' && msg.type !== 'DOC_CHANGED' && msg.type !== 'DOC_TYPED')) return false;
  if (HOST_TAB_ID == null || msg.tabId !== HOST_TAB_ID) return false;
  if (state.docId && msg.docId && msg.docId !== state.docId) return false;
  if (msg.type !== 'SELECTION_UPDATE' && docSignalTap) { try { docSignalTap(msg); } catch (e) { /* the tap's own problem */ } }
  if (msg.type === 'DOC_CHANGED') { onDocChanged(msg); return false; }
  if (msg.type === 'DOC_TYPED') { onDocTyped(msg); return false; }
  const text = typeof msg.text === 'string' ? msg.text : '';
  if (state.busy) {
    state.pendingSelection = text;
    if (!showYourTurnSelection(text)) return false;
  }
  state.selection = text;
  renderSelection();
  return false;
}

// Applies the latest selection pushed by the document while a request was running. Called on
// every exit of sendMessage (normal finish and the early bail() paths).
function applyPendingSelection() {
  if (state.pendingSelection === null) return;
  state.selection = state.pendingSelection;
  state.pendingSelection = null;
  renderSelection();
}

// How a paste was done, from the content script's answer: "inserted via paste event (detected by the editor
// change) · 2 attempts" (empty when the answer says nothing).
function pasteDetail(r) {
  const how = r && typeof r.detail === 'string' ? r.detail : '';
  const n = r && Number.isFinite(r.attempts) && r.attempts > 1 ? `${r.attempts} attempts` : ''; // one attempt is the rule, not news
  return [how, n].filter(Boolean).join(' · ');
}

// Applies text to the selection in the document. Returns { ok, message, verified?, detail?, attempts?, copied?,
// selectionChanged? } (detail of a paste: how it was inserted, pasteDetail). A paste the content script sent
// but Docs did not confirm ({ok: true, verified: false}) is still ok: message PASTE_UNCONFIRMED, verified false,
// and no clipboard copy (the text is most likely in the document already; the next message re-reads it).
// Replacements run strictly one at a time (the button and the tool must never paste concurrently).
// expected: the selection the model saw (replace_selection); when the live selection differs, the
// content script does not paste and the text goes to the clipboard. Without it (the "Apply" buttons,
// or nothing was selected: insert at the cursor) the text is pasted wherever the cursor is.
async function applyToDocument(text, expected) {
  const prev = state.applying || Promise.resolve();
  const run = prev.then(() => applyToDocumentNow(text, expected));
  state.applying = run.catch(() => {});
  return run;
}

// The content script moves the focus to the Docs editor for the paste; bring it back to the
// panel's input (where the user was working). This is also needed before the clipboard fallback,
// because the clipboard can only be written from a focused document.
function refocusPanel() {
  try { window.focus(); el.input.focus(); } catch (e) { /* ignore */ }
}

async function applyToDocumentNow(text, expected) {
  let errText = '';
  let selectionChanged = false;
  try {
    const msg = { type: 'REPLACE_SELECTION', text };
    if (expected) msg.expected = expected;
    const r = await sendToTab(msg);
    refocusPanel();
    if (r && r.ok) {
      state.selection = '';
      renderSelection();
      const verified = r.verified !== false; // an answer without the field (older content script): as before
      const out = { ok: true, message: verified ? 'Replaced in document' : PASTE_UNCONFIRMED, verified };
      const detail = pasteDetail(r);
      if (detail) out.detail = detail;
      if (Number.isFinite(r.attempts)) out.attempts = r.attempts;
      return out;
    }
    selectionChanged = !!(r && r.reason === 'selection-changed');
    errText = (r && r.error) || (selectionChanged ? 'the selection changed' : 'unknown error');
  } catch (e) {
    errText = e.message;
  }
  // The focus may still be in the Docs editor (e.g. the message failed after the content script
  // focused it); the clipboard can only be written from the focused panel document.
  refocusPanel();
  let copied = false;
  try { await navigator.clipboard.writeText(text); copied = true; } catch (e) { /* ignore */ }
  if (selectionChanged) {
    const message = copied ? SELECTION_CHANGED_NOTICE
      : 'The selection changed while the answer was being generated, so the text was not pasted; copying it to the clipboard also failed.';
    addNotice(message, { sticky: true });
    return { ok: false, message, detail: errText, copied, selectionChanged: true };
  }
  // The technical detail (which insertion methods were tried) is appended for debugging.
  const message = (copied
    ? 'Could not paste automatically. The text was copied to the clipboard; press Ctrl+V in the document.'
    : 'Could not paste automatically, and copying the text to the clipboard also failed.') +
    (errText ? ` (${errText})` : '');
  return { ok: false, message, detail: errText, copied };
}

// ---------------------------------------------------------------------------
// Scrolling the editor to a line
// ---------------------------------------------------------------------------
// Line links (the /check report, the location line) call this on click only. The content script finds the line in the
// editor by its text (SCROLL_TO_LINE; see content.js) and scrolls it into view; of: the document's line count, for a
// first jump to about the right place when the editor has not drawn that page yet. Resolves with the content script's
// reply ({ ok, how } or { ok: false, reason }); a failure shows a notice.
const SCROLL_NOT_FOUND = 'Could not find the line in the editor view.';
async function scrollToLine(line, text) {
  const of = state.docModel ? state.docModel.lines.length : state.docText ? state.docText.split('\n').length : 0;
  let r;
  try { r = await sendToTab({ type: 'SCROLL_TO_LINE', line: Number(line) || 0, text: String(text || ''), of }); } catch (e) { r = { ok: false, reason: 'error', error: e.message }; }
  if (!r || !r.ok) addNotice(SCROLL_NOT_FOUND);
  return r || { ok: false, reason: 'no-answer' };
}
